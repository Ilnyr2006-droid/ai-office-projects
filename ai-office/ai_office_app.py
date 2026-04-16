#!/usr/bin/env python3
import argparse
import re
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib import error as urlerror
from urllib import request as urlrequest


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8787
DEFAULT_TIMEOUT_SEC = 900
DEFAULT_LOG_FILE = "ai_office_chat_log.txt"
MAX_HISTORY_MESSAGES = 14
APP_BUILD = "2026-04-12-04"
ENABLE_SESSION_RESUME = False
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_DEFAULT_MODEL = "openrouter/free"
OPENROUTER_FALLBACK_MODELS = (
    "openrouter/free",
    "google/gemma-4-31b-it:free",
    "qwen/qwen3-32b:free",
)
DEFAULT_STORAGE_DIRNAME = "AI office"
ROOT_RUNNER_SCRIPT = "ai_office_root_runner.sh"
STATE_FILE_NAME = "ai_office_state.json"
MAX_FINGERPRINT_FILES = 4000
IGNORE_SCAN_DIRS = {
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".idea",
    ".vscode",
    "dist",
    "build",
    ".next",
}
LOG_CHAT_RE = re.compile(
    r"^\[(?P<ts>[^\]]+)\] \[project=(?P<pid>[^\]]+)\] "
    r"\[(?P<mode>together|gemini|codex)\] "
    r"(?P<role>USER|GEMINI|CODEX|LEAD) "
    r"\(tokens~(?P<tok>\d+)\): (?P<text>.*)$"
)


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    # Approximation used for local counters without provider tokenizer.
    return max(1, math.ceil(len(text) / 4))


def load_local_env() -> None:
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if key and key not in os.environ:
                os.environ[key] = value
    except Exception:
        # Non-fatal: app can still run without local .env.
        pass


class AIOfficeState:
    def __init__(self, log_path: Path, timeout_sec: int) -> None:
        self.lock = threading.Lock()
        self.process_lock = threading.Lock()
        self.log_path = log_path
        self.timeout_sec = timeout_sec
        self.projects: dict[str, dict] = {}
        self.project_order: list[str] = []
        self.next_project_seq = 1
        self.totals = {
            "all_messages": 0,
            "all_tokens_estimated": 0,
            "by_agent": {
                "user": {"messages": 0, "tokens": 0},
                "gemini": {"messages": 0, "tokens": 0},
                "codex": {"messages": 0, "tokens": 0},
                "lead": {"messages": 0, "tokens": 0},
            },
            "by_flow": {
                "gemini_prompt_tokens": 0,
                "gemini_output_tokens": 0,
                "codex_prompt_tokens": 0,
                "codex_output_tokens": 0,
                "lead_prompt_tokens": 0,
                "lead_output_tokens": 0,
            },
        }
        self.errors = []
        self.active_processes: dict[str, subprocess.Popen] = {}
        self.stop_requests: set[str] = set()
        self.state_path = Path(__file__).with_name(STATE_FILE_NAME)
        self.storage_root = self._default_storage_root()
        self.storage_root.mkdir(parents=True, exist_ok=True)
        loaded = self._load_state()
        if not loaded:
            self._import_projects_from_storage()
        if not self.project_order:
            self.create_project("New project")
        self._recover_flows_from_log_if_empty()
        self._recalculate_totals()
        self._save_state()
        self._bootstrap_status()

    def _default_storage_root(self) -> Path:
        desktop = Path.home() / "Desktop"
        if desktop.exists():
            return desktop / DEFAULT_STORAGE_DIRNAME
        return Path.home() / DEFAULT_STORAGE_DIRNAME

    def _normalize_storage_root(self, raw_path: str) -> Path:
        p = Path((raw_path or "").strip()).expanduser()
        if not p.is_absolute():
            p = (Path.cwd() / p).resolve()
        return p

    def _safe_folder_name(self, name: str) -> str:
        out = (name or "").strip()
        for ch in ("/", "\\", ":", "*", "?", '"', "<", ">", "|"):
            out = out.replace(ch, "-")
        out = " ".join(out.split())
        if out in ("", ".", ".."):
            out = "Project"
        return out[:120]

    def _unique_project_dir(self, root: Path, desired_name: str) -> Path:
        base = self._safe_folder_name(desired_name)
        candidate = root / base
        idx = 2
        while candidate.exists():
            candidate = root / f"{base} ({idx})"
            idx += 1
        return candidate

    def _claimed_paths(self) -> set[Path]:
        claimed: set[Path] = set()
        for p in self.projects.values():
            raw = (p.get("path") or "").strip()
            if not raw:
                continue
            try:
                claimed.add(Path(raw).resolve())
            except Exception:
                continue
        return claimed

    def _ensure_project_dir(self, project: dict, desired_name: str | None = None) -> None:
        if not self.storage_root.exists():
            self.storage_root.mkdir(parents=True, exist_ok=True)
        path_raw = project.get("path") or ""
        if path_raw:
            p = Path(path_raw)
            if p.exists() and p.is_dir():
                project["path"] = str(p)
                return
        base_name = self._safe_folder_name(desired_name or project["name"])
        preferred = self.storage_root / base_name
        claimed = self._claimed_paths()
        if preferred.exists():
            try:
                preferred_resolved = preferred.resolve()
            except Exception:
                preferred_resolved = preferred
            if preferred_resolved not in claimed:
                target = preferred
            else:
                target = self._unique_project_dir(self.storage_root, base_name)
        else:
            target = preferred
        target.mkdir(parents=True, exist_ok=True)
        project["path"] = str(target)

    def _remove_project_dir(self, project: dict) -> None:
        raw = (project.get("path") or "").strip()
        if not raw:
            return
        try:
            root_resolved = self.storage_root.resolve()
            target = Path(raw).resolve()
            if root_resolved not in target.parents:
                # Safety: never delete outside configured storage root.
                return
            if target.exists() and target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
        except Exception:
            return

    def set_storage_root(self, raw_path: str) -> dict:
        new_root = self._normalize_storage_root(raw_path)
        new_root.mkdir(parents=True, exist_ok=True)
        old_root = self.storage_root
        self.storage_root = new_root
        for project_id in self.project_order:
            project = self.projects[project_id]
            current_raw = project.get("path") or ""
            current = Path(current_raw).expanduser() if current_raw else None
            target = self._unique_project_dir(new_root, project["name"])
            moved = False
            if current and current.exists() and current.is_dir():
                try:
                    if current.resolve() != target.resolve():
                        shutil.move(str(current), str(target))
                    moved = True
                except Exception:
                    moved = False
            if not moved:
                target.mkdir(parents=True, exist_ok=True)
            project["path"] = str(target)
            project["updated_at"] = now_iso()
        self._log(
            f"[{now_iso()}] STORAGE root changed from={old_root} to={new_root}"
        )
        self._save_state()
        return self.get_project(None)

    def _bootstrap_status(self) -> None:
        gemini_ok = shutil.which("gemini") is not None
        codex_ok = shutil.which("codex") is not None
        if not gemini_ok:
            self.errors.append("Command 'gemini' not found in PATH.")
        if not codex_ok:
            self.errors.append("Command 'codex' not found in PATH.")
        self._log(
            f"[{now_iso()}] STATUS gemini={'ok' if gemini_ok else 'missing'} "
            f"codex={'ok' if codex_ok else 'missing'}"
        )

    def _log(self, line: str) -> None:
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    def _save_state(self) -> None:
        try:
            payload = {
                "version": 1,
                "saved_at": now_iso(),
                "storage_root": str(self.storage_root),
                "next_project_seq": self.next_project_seq,
                "project_order": self.project_order,
                "projects": self.projects,
                "totals": self.totals,
                "errors": self.errors[-100:],
            }
            tmp_path = self.state_path.with_suffix(".tmp")
            tmp_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            tmp_path.replace(self.state_path)
        except Exception:
            pass

    def _load_state(self) -> bool:
        if not self.state_path.exists():
            return False
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            storage_raw = str(data.get("storage_root") or "").strip()
            if storage_raw:
                self.storage_root = Path(storage_raw).expanduser()
            self.storage_root.mkdir(parents=True, exist_ok=True)

            projects = data.get("projects") or {}
            order = data.get("project_order") or []
            next_seq = int(data.get("next_project_seq") or 1)
            totals = data.get("totals") or {}
            errors = data.get("errors") or []
            if not isinstance(projects, dict) or not isinstance(order, list):
                return False

            self.projects = {}
            self.project_order = []
            for pid in order:
                if pid not in projects:
                    continue
                p = projects.get(pid) or {}
                if not isinstance(p, dict):
                    continue
                merged = self._new_project(pid, str(p.get("name") or pid))
                merged["path"] = str(p.get("path") or "")
                merged["created_at"] = str(p.get("created_at") or merged["created_at"])
                merged["updated_at"] = str(p.get("updated_at") or merged["updated_at"])
                flows = p.get("flows") or {}
                merged["flows"] = {
                    "together": list(flows.get("together") or []),
                    "gemini": list(flows.get("gemini") or []),
                    "codex": list(flows.get("codex") or []),
                }
                personas = p.get("personas") or {}
                merged["personas"] = {
                    "gemini": str(personas.get("gemini") or ""),
                    "codex": str(personas.get("codex") or ""),
                    "lead": str(personas.get("lead") or ""),
                }
                session_state = p.get("session_state") or {}
                merged["session_state"] = {
                    "gemini_started": bool(session_state.get("gemini_started") or False),
                    "codex_started": bool(session_state.get("codex_started") or False),
                }
                self._ensure_project_dir(merged, merged["name"])
                self.projects[pid] = merged
                self.project_order.append(pid)

            self.next_project_seq = max(next_seq, 1)
            if self.projects:
                max_seen = 0
                for pid in self.projects.keys():
                    try:
                        max_seen = max(max_seen, int(str(pid).lstrip("p")))
                    except Exception:
                        continue
                self.next_project_seq = max(self.next_project_seq, max_seen + 1)

            if isinstance(totals, dict) and totals:
                self.totals = totals
            if isinstance(errors, list):
                self.errors = [str(e) for e in errors][-100:]

            return bool(self.project_order)
        except Exception:
            return False

    def _import_projects_from_storage(self) -> None:
        if not self.storage_root.exists() or not self.storage_root.is_dir():
            return
        dirs = []
        try:
            for child in self.storage_root.iterdir():
                if not child.is_dir():
                    continue
                if child.name.startswith("."):
                    continue
                dirs.append(child)
        except Exception:
            return
        if not dirs:
            return
        dirs.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
        for folder in dirs:
            project_id = f"p{self.next_project_seq}"
            self.next_project_seq += 1
            project = self._new_project(project_id, folder.name)
            project["path"] = str(folder.resolve())
            project["updated_at"] = now_iso()
            self.projects[project_id] = project
            self.project_order.append(project_id)
            self._log(
                f"[{now_iso()}] PROJECT import id={project_id} name={project['name']} path={project['path']}"
            )

    def _flows_empty(self) -> bool:
        for project in self.projects.values():
            flows = project.get("flows") or {}
            if flows.get("together") or flows.get("gemini") or flows.get("codex"):
                return False
        return True

    def _recalculate_totals(self) -> None:
        totals = {
            "all_messages": 0,
            "all_tokens_estimated": 0,
            "by_agent": {
                "user": {"messages": 0, "tokens": 0},
                "gemini": {"messages": 0, "tokens": 0},
                "codex": {"messages": 0, "tokens": 0},
                "lead": {"messages": 0, "tokens": 0},
            },
            "by_flow": {
                "gemini_prompt_tokens": 0,
                "gemini_output_tokens": 0,
                "codex_prompt_tokens": 0,
                "codex_output_tokens": 0,
                "lead_prompt_tokens": 0,
                "lead_output_tokens": 0,
            },
        }
        for project in self.projects.values():
            flows = project.get("flows") or {}
            for mode in ("together", "gemini", "codex"):
                msgs = list(flows.get(mode) or [])
                for msg in msgs:
                    text = str(msg.get("text") or "")
                    role = str(msg.get("role") or "").lower()
                    tok = int(msg.get("tokens_estimated") or estimate_tokens(text))
                    msg["tokens_estimated"] = tok
                    totals["all_messages"] += 1
                    totals["all_tokens_estimated"] += tok
                    if role in totals["by_agent"]:
                        totals["by_agent"][role]["messages"] += 1
                        totals["by_agent"][role]["tokens"] += tok
        self.totals = totals

    def _recover_flows_from_log_if_empty(self) -> None:
        if not self._flows_empty():
            return
        if not self.log_path.exists():
            return
        project_ids = set(self.projects.keys())
        if not project_ids:
            return
        try:
            lines = self.log_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except Exception:
            return
        current = None
        recovered = 0
        for line in lines:
            m = LOG_CHAT_RE.match(line)
            if m:
                if current is not None:
                    pid = current["pid"]
                    if pid in project_ids:
                        self.projects[pid]["flows"][current["mode"]].append(current["msg"])
                        recovered += 1
                pid = m.group("pid")
                mode = m.group("mode")
                role = m.group("role").lower()
                ts = m.group("ts")
                tok = int(m.group("tok") or 0)
                text = m.group("text")
                current = {
                    "pid": pid,
                    "mode": mode,
                    "msg": {
                        "timestamp": ts,
                        "mode": mode,
                        "role": role,
                        "text": text,
                        "tokens_estimated": tok if tok > 0 else estimate_tokens(text),
                    },
                }
                continue
            if current is not None:
                current["msg"]["text"] += ("\n" + line)
        if current is not None:
            pid = current["pid"]
            if pid in project_ids:
                self.projects[pid]["flows"][current["mode"]].append(current["msg"])
                recovered += 1
        if recovered <= 0:
            return
        # Keep UI responsive: cap history per flow.
        max_msgs_per_flow = 400
        for project in self.projects.values():
            for mode in ("together", "gemini", "codex"):
                flow = project["flows"][mode]
                if len(flow) > max_msgs_per_flow:
                    project["flows"][mode] = flow[-max_msgs_per_flow:]
            project["updated_at"] = now_iso()
        self._log(f"[{now_iso()}] RECOVERY restored_messages={recovered}")

    def _new_project(self, project_id: str, name: str) -> dict:
        return {
            "id": project_id,
            "name": name,
            "path": "",
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "flows": {"together": [], "gemini": [], "codex": []},
            "personas": {"gemini": "", "codex": "", "lead": ""},
            "session_state": {"gemini_started": False, "codex_started": False},
        }

    def create_project(self, name: str) -> dict:
        safe_name = (name or "").strip() or f"Project {self.next_project_seq}"
        project_id = f"p{self.next_project_seq}"
        self.next_project_seq += 1
        project = self._new_project(project_id, safe_name)
        self._ensure_project_dir(project, safe_name)
        self.projects[project_id] = project
        self.project_order.insert(0, project_id)
        self._log(
            f"[{now_iso()}] PROJECT create id={project_id} name={safe_name} path={project['path']}"
        )
        self._save_state()
        return project

    def list_projects(self) -> list[dict]:
        out = []
        for project_id in self.project_order:
            p = self.projects[project_id]
            flow = p["flows"]
            count = len(flow["gemini"]) + len(flow["codex"]) + len(flow["together"])
            out.append(
                {
                    "id": p["id"],
                    "name": p["name"],
                    "path": p.get("path", ""),
                    "updated_at": p["updated_at"],
                    "messages_count": count,
                }
            )
        return out

    def rename_project(self, project_id: str, name: str) -> dict:
        if project_id not in self.projects:
            raise KeyError("Project not found")
        safe_name = (name or "").strip()
        if not safe_name:
            raise ValueError("Project name is required")
        project = self.projects[project_id]
        if project["name"] == safe_name:
            return project
        old_path = Path(project.get("path") or "")
        project["name"] = safe_name
        target = self._unique_project_dir(self.storage_root, safe_name)
        moved = False
        if old_path.exists() and old_path.is_dir():
            try:
                if old_path.resolve() != target.resolve():
                    shutil.move(str(old_path), str(target))
                moved = True
            except Exception:
                moved = False
        if not moved:
            target.mkdir(parents=True, exist_ok=True)
        project["path"] = str(target)
        project["updated_at"] = now_iso()
        self._log(
            f"[{now_iso()}] PROJECT rename id={project_id} name={safe_name} path={project['path']}"
        )
        self._save_state()
        return self.projects[project_id]

    def delete_project(self, project_id: str) -> dict:
        if project_id not in self.projects:
            raise KeyError("Project not found")
        if len(self.project_order) == 1:
            raise ValueError("Cannot delete the last project")
        self.project_order = [p for p in self.project_order if p != project_id]
        deleted = self.projects.pop(project_id)
        self._remove_project_dir(deleted)
        self._log(f"[{now_iso()}] PROJECT delete id={project_id} name={deleted['name']}")
        self._save_state()
        return self.projects[self.project_order[0]]

    def set_persona(self, project_id: str, model: str, prompt: str) -> dict:
        if model not in ("gemini", "codex", "lead"):
            raise ValueError("Invalid model")
        project = self.get_project(project_id)
        project["personas"][model] = (prompt or "").strip()
        project["updated_at"] = now_iso()
        self._log(
            f"[{now_iso()}] PROJECT persona set project={project['id']} model={model} "
            f"len={len(project['personas'][model])}"
        )
        self._save_state()
        return project

    def get_project(self, project_id: str | None) -> dict:
        if project_id and project_id in self.projects:
            return self.projects[project_id]
        if not self.project_order:
            return self.create_project("New project")
        return self.projects[self.project_order[0]]

    def add_message(self, project_id: str, mode: str, role: str, text: str) -> dict:
        project = self.get_project(project_id)
        msg = {
            "timestamp": now_iso(),
            "mode": mode,
            "role": role,
            "text": text,
            "tokens_estimated": estimate_tokens(text),
        }
        project["flows"][mode].append(msg)
        project["updated_at"] = now_iso()
        self.totals["all_messages"] += 1
        self.totals["all_tokens_estimated"] += msg["tokens_estimated"]
        if role in self.totals["by_agent"]:
            self.totals["by_agent"][role]["messages"] += 1
            self.totals["by_agent"][role]["tokens"] += msg["tokens_estimated"]
        self._log(
            f"[{msg['timestamp']}] [project={project['id']}] [{mode}] {role.upper()} "
            f"(tokens~{msg['tokens_estimated']}): {text}"
        )
        self._save_state()
        return msg

    def snapshot(self, project_id: str, mode: str) -> dict:
        project = self.get_project(project_id)
        return {
            "project_id": project["id"],
            "mode": mode,
            "messages": project["flows"][mode],
            "totals": self.totals,
            "errors": self.errors,
            "timestamp": now_iso(),
            "build": APP_BUILD,
        }

    def snapshot_all(self, project_id: str | None = None) -> dict:
        project = self.get_project(project_id)
        return {
            "project_id": project["id"],
            "project_name": project["name"],
            "project_path": project.get("path", ""),
            "storage_root": str(self.storage_root),
            "projects": self.list_projects(),
            "personas": project["personas"],
            "flows": {
                "gemini": project["flows"]["gemini"],
                "codex": project["flows"]["codex"],
                "together": project["flows"]["together"],
            },
            "totals": self.totals,
            "errors": self.errors,
            "timestamp": now_iso(),
            "build": APP_BUILD,
        }

    def reset_mode(self, project_id: str, mode: str) -> None:
        project = self.get_project(project_id)
        project["flows"][mode] = []
        project["updated_at"] = now_iso()
        self._log(f"[{now_iso()}] RESET project={project['id']} mode={mode}")
        self._save_state()

    def reset_all(self, project_id: str) -> None:
        project = self.get_project(project_id)
        project["flows"] = {"together": [], "gemini": [], "codex": []}
        project["updated_at"] = now_iso()
        self._log(f"[{now_iso()}] RESET project={project['id']} mode=all")
        self._save_state()

    def _stop_key(self, project_id: str, mode: str) -> str:
        return f"{project_id}:{mode}"

    def clear_stop_request(self, project_id: str, mode: str) -> None:
        key = self._stop_key(project_id, mode)
        with self.process_lock:
            self.stop_requests.discard(key)

    def request_stop(self, project_id: str, mode: str) -> None:
        key = self._stop_key(project_id, mode)
        with self.process_lock:
            self.stop_requests.add(key)
            proc = self.active_processes.get(key)
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass

    def is_stop_requested(self, project_id: str, mode: str) -> bool:
        key = self._stop_key(project_id, mode)
        with self.process_lock:
            return key in self.stop_requests

    def _root_mode_enabled(self) -> bool:
        return (os.getenv("AI_OFFICE_USE_ROOT") or "").strip().lower() in {"1", "true", "yes", "on"}

    def _with_root_wrapper(self, cmd: list[str], workdir: Path) -> list[str]:
        if not self._root_mode_enabled():
            return cmd
        runner = Path(__file__).with_name(ROOT_RUNNER_SCRIPT)
        return ["sudo", "-n", str(runner), str(self.storage_root), str(workdir), *cmd]

    def call_model(self, project_id: str, mode: str, command: str, prompt: str) -> tuple[bool, str]:
        project = self.get_project(project_id)
        stop_key = self._stop_key(project_id, mode)
        cmd = [command, prompt]
        output_file = None
        workdir = Path(project.get("path") or "").expanduser()
        if not workdir.exists():
            try:
                workdir.mkdir(parents=True, exist_ok=True)
            except Exception:
                workdir = Path.cwd()
        if not workdir.is_dir():
            workdir = Path.cwd()
        if self.is_stop_requested(project_id, mode):
            return False, "[STOPPED] Generation stopped by user."
        if command == "codex":
            # Use non-interactive mode for server-side calls (no TTY required).
            tmp = tempfile.NamedTemporaryFile(prefix="ai_office_codex_", suffix=".txt", delete=False)
            tmp.close()
            output_file = tmp.name
            if ENABLE_SESSION_RESUME and project["session_state"].get("codex_started"):
                cmd = [
                    "codex",
                    "exec",
                    "resume",
                    "--last",
                    "--full-auto",
                    "--sandbox",
                    "workspace-write",
                    "--cd",
                    str(workdir),
                    "--skip-git-repo-check",
                    "--output-last-message",
                    output_file,
                    prompt,
                ]
            else:
                cmd = [
                    "codex",
                    "exec",
                    "--full-auto",
                    "--sandbox",
                    "workspace-write",
                    "--cd",
                    str(workdir),
                    "--skip-git-repo-check",
                    "--output-last-message",
                    output_file,
                    prompt,
                ]
        elif command == "gemini":
            # Keep gemini session sticky between messages in the same project.
            if ENABLE_SESSION_RESUME and project["session_state"].get("gemini_started"):
                cmd = [
                    "gemini",
                    "--approval-mode",
                    "yolo",
                    "--resume",
                    "--prompt",
                    prompt,
                ]
            else:
                cmd = [
                    "gemini",
                    "--approval-mode",
                    "yolo",
                    "--prompt",
                    prompt,
                ]
        proc = None
        try:
            launch_cmd = self._with_root_wrapper(cmd, workdir)
            proc = subprocess.Popen(
                launch_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=str(workdir),
            )
            with self.process_lock:
                self.active_processes[stop_key] = proc

            started_at = time.monotonic()
            stdout = ""
            stderr = ""
            # Use short-timeout communicate loop to continuously drain pipes and
            # avoid deadlocks on verbose stderr/stdout.
            while True:
                if self.is_stop_requested(project_id, mode):
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                    try:
                        proc.wait(timeout=1)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                    return False, "[STOPPED] Generation stopped by user."

                if (time.monotonic() - started_at) > self.timeout_sec:
                    try:
                        proc.terminate()
                    except Exception:
                        pass
                    try:
                        proc.wait(timeout=1)
                    except Exception:
                        try:
                            proc.kill()
                        except Exception:
                            pass
                    return False, f"[ERROR] '{command}' timeout after {self.timeout_sec}s."

                try:
                    out, err = proc.communicate(timeout=0.2)
                    stdout = out or ""
                    stderr = err or ""
                    break
                except subprocess.TimeoutExpired:
                    continue
        except Exception as exc:
            return False, f"[ERROR] failed to execute '{command}': {exc}"
        finally:
            with self.process_lock:
                self.active_processes.pop(stop_key, None)

        stdout = (stdout or "").strip()
        stderr = (stderr or "").strip()
        if output_file:
            try:
                with open(output_file, "r", encoding="utf-8") as f:
                    stdout = (f.read() or "").strip()
            except OSError:
                pass
            finally:
                try:
                    os.unlink(output_file)
                except OSError:
                    pass

        if proc.returncode != 0:
            # Fallback: if resume failed because no prior session, try fresh call once.
            if ENABLE_SESSION_RESUME and command == "codex" and project["session_state"].get("codex_started"):
                retry_tmp = tempfile.NamedTemporaryFile(prefix="ai_office_codex_retry_", suffix=".txt", delete=False)
                retry_tmp.close()
                retry_output_file = retry_tmp.name
                try:
                    retry_cmd = self._with_root_wrapper(
                        [
                            "codex",
                            "exec",
                            "--full-auto",
                            "--sandbox",
                            "workspace-write",
                            "--cd",
                            str(workdir),
                            "--skip-git-repo-check",
                            "--output-last-message",
                            retry_output_file,
                            prompt,
                        ],
                        workdir,
                    )
                    retry_proc = subprocess.run(
                        retry_cmd,
                        capture_output=True,
                        text=True,
                        timeout=self.timeout_sec,
                        check=False,
                        cwd=str(workdir),
                    )
                    retry_stdout = (retry_proc.stdout or "").strip()
                    retry_stderr = (retry_proc.stderr or "").strip()
                    try:
                        with open(retry_output_file, "r", encoding="utf-8") as f:
                            retry_stdout = (f.read() or "").strip()
                    except OSError:
                        pass
                    finally:
                        try:
                            os.unlink(retry_output_file)
                        except OSError:
                            pass
                    if retry_proc.returncode == 0 and retry_stdout:
                        project["session_state"]["codex_started"] = True
                        return True, retry_stdout
                except Exception:
                    pass
            if ENABLE_SESSION_RESUME and command == "gemini" and project["session_state"].get("gemini_started"):
                try:
                    retry_cmd = self._with_root_wrapper(
                        [
                            "gemini",
                            "--approval-mode",
                            "yolo",
                            "--prompt",
                            prompt,
                        ],
                        workdir,
                    )
                    retry_proc = subprocess.run(
                        retry_cmd,
                        capture_output=True,
                        text=True,
                        timeout=self.timeout_sec,
                        check=False,
                        cwd=str(workdir),
                    )
                    retry_stdout = (retry_proc.stdout or "").strip()
                    if retry_proc.returncode == 0 and retry_stdout:
                        project["session_state"]["gemini_started"] = True
                        return True, retry_stdout
                except Exception:
                    pass
            return (
                False,
                f"[ERROR] '{command}' exited with code {proc.returncode}. "
                f"stderr: {stderr or '<empty>'}",
            )
        if not stdout:
            return False, f"[ERROR] '{command}' returned empty output."
        if command == "codex":
            project["session_state"]["codex_started"] = True
        if command == "gemini":
            project["session_state"]["gemini_started"] = True
        return True, stdout

    def call_team_lead(self, project_id: str, mode: str, prompt: str) -> tuple[bool, str]:
        if self.is_stop_requested(project_id, mode):
            return False, "[STOPPED] Generation stopped by user."
        api_key = (os.getenv("OPENROUTER_API_KEY") or "").strip()
        if not api_key:
            return False, "[ERROR] OPENROUTER_API_KEY is not set."
        model = (os.getenv("OPENROUTER_MODEL") or OPENROUTER_DEFAULT_MODEL).strip()
        model_list_raw = (os.getenv("OPENROUTER_MODELS") or "").strip()
        fallback_models = []
        if model_list_raw:
            fallback_models.extend([m.strip() for m in model_list_raw.split(",") if m.strip()])
        fallback_models.extend([model])
        fallback_models.extend(list(OPENROUTER_FALLBACK_MODELS))
        # Keep order, drop duplicates.
        models = []
        seen = set()
        for m in fallback_models:
            if m and m not in seen:
                models.append(m)
                seen.add(m)
        app_name = (os.getenv("OPENROUTER_APP_NAME") or "AI Office").strip()
        app_url = (os.getenv("OPENROUTER_SITE_URL") or "http://127.0.0.1:8787").strip()

        body = ""
        last_error = ""
        for current_model in models:
            payload = {
                "model": current_model,
                "temperature": 0.3,
                "max_tokens": 260,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are Team Lead for two developers: Gemini and Codex. "
                            "Do not ask them to talk to each other. "
                            "Always answer in the user's language. "
                            "If user message is greeting/small-talk, reply with one short sentence "
                            "(max 12 words) and one short follow-up question. "
                            "For real tasks, reply directly to user with concise execution plan, "
                            "task split, and next actions."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
            }
            raw = json.dumps(payload).encode("utf-8")
            req = urlrequest.Request(OPENROUTER_API_URL, data=raw, method="POST")
            req.add_header("Authorization", f"Bearer {api_key}")
            req.add_header("Content-Type", "application/json")
            req.add_header("HTTP-Referer", app_url)
            req.add_header("X-Title", app_name)
            try:
                with urlrequest.urlopen(req, timeout=self.timeout_sec) as resp:
                    body = resp.read().decode("utf-8", errors="replace")
                break
            except urlerror.HTTPError as exc:
                err_body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
                msg = exc.reason
                try:
                    payload_err = json.loads(err_body)
                    msg = ((payload_err.get("error") or {}).get("message")) or msg
                except Exception:
                    pass
                last_error = f"HTTP {exc.code}: {msg}"
                # 429 on free model: try next fallback model.
                if exc.code == 429:
                    continue
                return False, f"[ERROR] OpenRouter {last_error}"
            except Exception as exc:
                return False, f"[ERROR] OpenRouter request failed: {exc}"
        else:
            if last_error:
                return False, (
                    "[ERROR] OpenRouter free models are temporarily overloaded (429). "
                    "Please retry in 30-60 seconds or set OPENROUTER_MODELS with alternate free models."
                )
            return False, "[ERROR] OpenRouter request failed."

        if self.is_stop_requested(project_id, mode):
            return False, "[STOPPED] Generation stopped by user."

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            return False, f"[ERROR] OpenRouter returned invalid JSON: {body[:500]}"
        choices = data.get("choices") or []
        if not choices:
            # Some providers return top-level output fields without choices.
            alt = str(data.get("output_text") or data.get("response") or "").strip()
            if alt:
                return True, alt
            return False, f"[ERROR] OpenRouter returned no choices: {body[:500]}"
        msg = (choices[0] or {}).get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            parts = []
            for item in content:
                if isinstance(item, dict):
                    parts.append(str(item.get("text") or item.get("content") or item.get("value") or ""))
                else:
                    parts.append(str(item))
            content = "\n".join(x for x in parts if x).strip()
        else:
            content = str(content or "").strip()
        if not content:
            # Fallbacks for providers that place content differently.
            first = choices[0] or {}
            content = str(first.get("text") or first.get("output_text") or "").strip()
        if not content:
            alt = str(data.get("output_text") or data.get("response") or "").strip()
            if alt:
                content = alt
        if not content:
            return False, "[ERROR] OpenRouter returned empty content."
        return True, content


def build_history_block(messages: list) -> str:
    tail = messages[-MAX_HISTORY_MESSAGES:]
    lines = []
    for msg in tail:
        role = msg["role"].upper()
        lines.append(f"{role}: {msg['text']}")
    return "\n".join(lines) if lines else "No prior messages."


def model_prompt(
    model_name: str,
    mode: str,
    user_text: str,
    history: list,
    custom_instruction: str = "",
    bridge: str = "",
    workdir: str = "",
) -> str:
    custom_block = ""
    if custom_instruction.strip():
        custom_block = f"Persistent instruction for {model_name}:\n{custom_instruction.strip()}\n\n"
    lang_block = ""
    if (model_name or "").strip().lower() == "gemini":
        lang_block = "Language rule: always respond in Russian.\n\n"
    bridge_block = f"{bridge}\n\n" if bridge else ""
    return (
        f"You are {model_name}. Collaborate in a multi-agent CLI workspace.\n"
        "Be concise, correct, and practical. Ask clarifying questions when needed.\n"
        "When useful, provide actionable steps and code snippets.\n\n"
        f"Conversation mode: {mode}\n\n"
        f"Project working directory: {workdir or '<unknown>'}\n"
        "Always assume file operations should happen in this directory unless user says otherwise.\n\n"
        f"{lang_block}"
        f"{custom_block}"
        "Recent context:\n"
        f"{build_history_block(history)}\n\n"
        f"{bridge_block}"
        "New user request:\n"
        f"{user_text}"
    )


def lead_prompt(user_text: str, history: list, custom_instruction: str = "") -> str:
    custom = f"Persistent instruction for Team Lead:\n{custom_instruction.strip()}\n\n" if custom_instruction.strip() else ""
    return (
        "You are Team Lead in AI Office.\n"
        "You manage work between Gemini and Codex, but they must NOT talk to each other directly.\n"
        "Use user's language.\n"
        "If the message is greeting/small-talk (e.g. 'привет', 'hi', 'как дела'), "
        "respond in 1 short sentence + 1 short question, no lists.\n"
        "If this is a real task, return practical short response with:\n"
        "1) goal understanding, 2) task split, 3) immediate next step.\n\n"
        f"{custom}"
        "Recent context:\n"
        f"{build_history_block(history)}\n\n"
        "New user request:\n"
        f"{user_text}"
    )


def detect_targets(user_text: str) -> tuple[bool, bool]:
    text = (user_text or "").lower()
    frontend_keys = (
        "frontend", "front-end", "ui", "ux", "верстк", "интерфейс", "клиент",
        "react", "vue", "next", "nuxt", "css", "html", "tailwind",
    )
    backend_keys = (
        "backend", "back-end", "api", "server", "бэкенд", "сервер", "бд",
        "database", "postgres", "mysql", "redis", "fastapi", "django", "node",
        "express", "nestjs", "auth", "jwt",
    )
    wants_front = any(k in text for k in frontend_keys)
    wants_back = any(k in text for k in backend_keys)
    if not wants_front and not wants_back:
        return True, True
    return wants_front, wants_back


def is_smalltalk(text: str) -> bool:
    t = (text or "").strip().lower()
    if not t:
        return False
    normalized = " ".join(t.replace("!", " ").replace("?", " ").replace(".", " ").split())
    short_set = {
        "привет", "здарова", "здорово", "салам", "ку", "хай",
        "hello", "hi", "hey", "yo",
        "как дела", "как вы",
    }
    return normalized in short_set


def is_management_question(text: str) -> bool:
    t = (text or "").strip().lower()
    if not t:
        return False
    mgmt_keys = (
        "кто должен", "кто первый", "кто из разработчиков", "с чего начать",
        "порядок работ", "как лучше", "как правильно", "что сначала",
        "какой процесс", "кто начинает", "кто должен первым",
        "who should", "who starts", "what should be first", "process",
    )
    dev_exec_keys = (
        "сделай", "реализуй", "напиши", "создай", "исправь", "пофикси",
        "implement", "build", "create", "fix", "write code",
        "api", "endpoint", "component", "верстк", "frontend", "backend",
    )
    has_mgmt = any(k in t for k in mgmt_keys)
    has_exec = any(k in t for k in dev_exec_keys)
    return has_mgmt and not has_exec


def is_delivery_request(text: str) -> bool:
    t = (text or "").strip().lower()
    if not t:
        return False
    delivery_keys = (
        "сделай", "создай", "реализуй", "допили", "доведи до конца", "до конца",
        "полностью", "готовый", "рабочий", "build", "implement", "create", "finish",
        "ship", "production", "deploy", "application", "app", "веб приложение",
        "веб-приложение", "сайт", "проект",
    )
    return any(k in t for k in delivery_keys)


def collect_project_fingerprint(project_path: str) -> dict[str, tuple[int, int]]:
    root = Path(project_path)
    out: dict[str, tuple[int, int]] = {}
    if not root.exists() or not root.is_dir():
        return out
    scanned = 0
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in IGNORE_SCAN_DIRS]
            for name in filenames:
                fp = Path(dirpath) / name
                try:
                    st = fp.stat()
                    rel = str(fp.relative_to(root))
                    out[rel] = (int(st.st_mtime_ns), int(st.st_size))
                    scanned += 1
                    if scanned >= MAX_FINGERPRINT_FILES:
                        return out
                except OSError:
                    continue
    except Exception:
        return out
    return out


def summarize_project_changes(
    before: dict[str, tuple[int, int]],
    after: dict[str, tuple[int, int]],
    limit: int = 10,
) -> dict[str, object]:
    before_keys = set(before.keys())
    after_keys = set(after.keys())
    added = sorted(after_keys - before_keys)
    deleted = sorted(before_keys - after_keys)
    modified = sorted(
        p for p in (before_keys & after_keys) if before.get(p) != after.get(p)
    )
    total = len(added) + len(deleted) + len(modified)
    preview = []
    for p in added[:limit]:
        preview.append(f"+ {p}")
    for p in modified[:limit]:
        preview.append(f"~ {p}")
    for p in deleted[:limit]:
        preview.append(f"- {p}")
    return {
        "added": added,
        "modified": modified,
        "deleted": deleted,
        "total": total,
        "preview": preview,
    }


def relay_target(text: str) -> str | None:
    t = (text or "").lower()
    has_relay_verb = any(k in t for k in ("передай", "скажи", "попроси", "tell", "ask", "send"))
    if not has_relay_verb:
        return None
    if any(k in t for k in ("gemini", "гемини", "джемини", "фронтенд", "frontend", "front-end", "ui", "ux")):
        return "gemini"
    if any(k in t for k in ("codex", "кодекс", "бэкенд", "бекенд", "backend", "back-end", "api", "сервер")):
        return "codex"
    return None


def history_for_worker(messages: list[dict], worker_role: str) -> list[dict]:
    allowed = {"user", "lead", worker_role}
    out = []
    for m in messages:
        if m.get("role") not in allowed:
            continue
        text = str(m.get("text") or "")
        # Do not leak lead user-facing summaries into worker history.
        if m.get("role") == "lead" and text.startswith("[Team Lead]"):
            continue
        out.append(m)
    return out


def fallback_lead_reply(user_text: str, worker_reports: list[str], had_worker_error: bool) -> str:
    snippets = []
    for report in worker_reports:
        txt = (report or "").strip()
        if not txt:
            continue
        # Keep short excerpt for readable fallback response.
        lines = [ln.strip() for ln in txt.splitlines() if ln.strip()]
        if not lines:
            continue
        head = lines[0]
        body = lines[1] if len(lines) > 1 else ""
        snippets.append((head, body))
    if snippets:
        merged = []
        for head, body in snippets[:2]:
            if body:
                merged.append(f"- {head} {body[:220]}")
            else:
                merged.append(f"- {head[:260]}")
        prefix = "[Team Lead] Сводка по исполнителям:\n"
        if had_worker_error:
            prefix += "Есть ошибки у части исполнителей, но продолжаем с доступными результатами.\n"
        return prefix + "\n".join(merged)
    return (
        "[Team Lead] Принял задачу, но сейчас не удалось собрать ответ от внешней модели. "
        "Попробуйте повторить запрос через 20-30 секунд."
    )


HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>AI Office Pro</title>
  <style>
    :root {
      --bg: #0b0b0c;
      --panel: rgba(28, 28, 30, 0.7);
      --card: #1c1c1e;
      --txt: #f5f5f7;
      --sub: rgba(255, 255, 255, 0.5);
      --border: rgba(255, 255, 255, 0.1);
      --blue: #0071e3;
      --blue-hover: #0077ed;
      --danger: #ff453a;
      --success: #32d74b;
      --user-accent: #30d158;
      --gemini-accent: #64d2ff;
      --codex-accent: #bf5af2;
    }
    
    * { box-sizing: border-box; -webkit-font-smoothing: antialiased; }
    body { 
      margin: 0; 
      background: var(--bg); 
      color: var(--txt); 
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5;
    }

    /* Layout */
    .app-shell {
      display: grid;
      grid-template-columns: 240px minmax(0, 1fr);
      height: 100vh;
      overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
      background: #000;
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      padding: 20px 16px;
    }
    .sidebar h2 { font-size: 22px; margin: 0 0 20px 0; font-weight: 700; letter-spacing: -0.5px; }
    
    .new-project-box { display: flex; gap: 8px; margin-bottom: 24px; }
    .new-project-box input { 
      flex: 1; background: #1c1c1e; border: 1px solid var(--border); 
      border-radius: 8px; padding: 8px 12px; color: #fff; font-size: 13px;
    }
    
    .project-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .project-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px;
      cursor: pointer;
      transition: all 0.2s ease;
    }
    .project-card:hover { border-color: rgba(255,255,255,0.3); background: #2c2c2e; }
    .project-card.active { border-color: var(--blue); background: rgba(0, 113, 227, 0.1); }
    .project-card .name { font-weight: 600; font-size: 15px; margin-bottom: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .project-card .info { font-size: 11px; color: var(--sub); display: flex; justify-content: space-between; }
    .project-actions { display: flex; gap: 8px; margin-top: 10px; opacity: 0.6; transition: opacity 0.2s; }
    .project-card:hover .project-actions { opacity: 1; }
    .btn-tiny { padding: 4px 8px; font-size: 10px; border-radius: 6px; background: transparent; border: 1px solid var(--border); color: var(--txt); cursor: pointer; }
    .btn-tiny:hover { background: rgba(255,255,255,0.1); }

    /* Main Area */
    .main-content {
      display: flex;
      flex-direction: column;
      background: var(--bg);
      overflow-y: auto;
      padding: 20px;
      gap: 20px;
    }

    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .header-actions { display: flex; gap: 8px; align-items: center; }
    .icon-btn {
      width: 36px;
      height: 36px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: #1c1c1e;
      color: var(--txt);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }
    .icon-btn:hover { border-color: var(--blue); color: var(--blue); }
    .current-project-info h1 { margin: 0; font-size: 24px; font-weight: 700; }
    .current-project-info p { margin: 4px 0 0 0; color: var(--sub); font-size: 13px; }
    
    /* Grid Layout */
    .chats-container {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 20px;
    }
    .full-width { grid-column: 1 / -1; }

    /* Generic Panel */
    .chat-panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
      overflow: hidden;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
    }
    .chat-panel h3 { margin: 0; font-size: 18px; display: flex; align-items: center; justify-content: space-between; }
    .panel-actions { display: flex; gap: 8px; align-items: center; }

    /* Chat Messages */
    .chat-display {
      height: 400px;
      overflow-y: auto;
      background: rgba(0,0,0,0.3);
      border-radius: 12px;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      border: 1px solid rgba(255,255,255,0.05);
    }
    .together-display { height: 300px; }

    .message {
      padding: 12px 14px;
      border-radius: 12px;
      max-width: 100%;
      position: relative;
      animation: fadeIn 0.3s ease;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }

    .message.user { align-self: flex-end; background: #323235; border-bottom-right-radius: 4px; border-left: 3px solid var(--user-accent); }
    .message.gemini { align-self: flex-start; background: #1c1c1e; border-bottom-left-radius: 4px; border-left: 3px solid var(--gemini-accent); }
    .message.codex { align-self: flex-start; background: #1c1c1e; border-bottom-left-radius: 4px; border-left: 3px solid var(--codex-accent); }
    .message.lead { align-self: flex-start; background: #1c1c1e; border-bottom-left-radius: 4px; border-left: 3px solid #ff9f0a; }
    .thinking-indicator {
      align-self: flex-start;
      background: transparent;
      border: none;
      color: var(--sub);
      padding: 6px 4px;
      max-width: 100%;
    }
    .thinking-text { font-size: 14px; display: inline-flex; align-items: center; gap: 2px; }
    .dots { display: inline-flex; width: 18px; justify-content: flex-start; }
    .dots span::before { content: "."; }
    .dots span { opacity: 0.15; animation: dotPulse 1.2s infinite; }
    .dots span:nth-child(2) { animation-delay: 0.2s; }
    .dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes dotPulse {
      0%, 80%, 100% { opacity: 0.15; }
      40% { opacity: 1; }
    }
    
    .msg-meta { font-size: 10px; color: var(--sub); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center; }
    .msg-text { font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .msg-text code { font-family: "SF Mono", "Menlo", "Monaco", "Consolas", monospace; background: rgba(255,255,255,0.1); padding: 2px 4px; border-radius: 4px; font-size: 13px; overflow-wrap: anywhere; word-break: break-all; }
    .msg-text pre { background: #000; padding: 12px; border-radius: 8px; overflow-x: auto; margin: 10px 0; border: 1px solid var(--border); }
    .msg-text pre code { background: transparent; padding: 0; }
    
    .copy-btn { 
      opacity: 0; position: absolute; right: 8px; top: 8px; 
      background: var(--card); border: 1px solid var(--border); 
      border-radius: 4px; color: var(--sub); cursor: pointer; padding: 4px;
      transition: opacity 0.2s;
    }
    .message:hover .copy-btn { opacity: 1; }
    .copy-btn:hover { color: #fff; border-color: #fff; }

    /* Inputs */
    .input-group { display: flex; gap: 10px; align-items: flex-end; }
    .input-group textarea {
      flex: 1; background: #2c2c2e; border: 1px solid var(--border);
      border-radius: 12px; padding: 12px; color: #fff; font-size: 14px;
      resize: none; min-height: 44px; max-height: 200px;
      transition: border-color 0.2s;
    }
    .input-group textarea:focus { border-color: var(--blue); outline: none; }
    
    /* Buttons */
    .btn {
      padding: 10px 20px; border-radius: 980px; font-size: 14px; font-weight: 600;
      border: none; cursor: pointer; transition: all 0.2s; display: inline-flex; align-items: center; gap: 6px;
    }
    .btn-primary { background: var(--blue); color: #fff; }
    .btn-primary:hover { background: var(--blue-hover); transform: scale(1.02); }
    .btn-primary:disabled { background: #444; cursor: not-allowed; opacity: 0.7; }
    
    .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
    .btn-danger:hover { background: var(--danger); color: #fff; }
    .hidden { display: none !important; }
    
    .btn-ghost { background: transparent; color: var(--sub); border: 1px solid var(--border); }
    .btn-ghost:hover { border-color: var(--txt); color: var(--txt); }
    .lead-dialog-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: -4px; }

    .errors { background: rgba(255, 69, 58, 0.1); color: var(--danger); padding: 10px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 10px; }
    .errors:empty { display: none; }

    /* Persona modal */
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 1000;
      display: none; align-items: center; justify-content: center; padding: 20px;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      width: min(760px, 96vw);
      background: #1c1c1e;
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.45);
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .modal h3 { margin: 0 0 10px 0; font-size: 20px; }
    .modal textarea {
      width: 100%;
      min-height: 180px;
      max-height: 58vh;
      background: #141416;
      border: 1px solid var(--border);
      border-radius: 10px;
      color: #fff;
      padding: 12px;
      font-size: 14px;
      resize: vertical;
      overflow: auto;
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
      background: #1c1c1e;
      position: sticky;
      bottom: 0;
    }

    /* Scrollbars */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 10px; }
    ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.2); }

    @media (max-width: 1000px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar { display: none; }
      .chats-container { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <aside class="sidebar">
      <h2>AI Office</h2>
      <div class="new-project-box">
        <input id="projectNameInput" placeholder="Название проекта..." />
        <button id="createProjectBtn" class="btn btn-primary" style="padding: 8px 12px;">+</button>
      </div>
      <div id="projects" class="project-list"></div>
    </aside>

    <main class="main-content">
      <div class="header-bar">
        <div class="current-project-info">
          <h1 id="projectTitle">Загрузка...</h1>
          <p id="projectStats">Обновлено: - · 0 сообщений</p>
        </div>
        <div class="header-actions">
          <button id="openStorageBtn" class="icon-btn" title="Папка проектов">&#128193;</button>
        </div>
      </div>

      <div id="errors" class="errors"></div>

      <div class="chats-container">
        <!-- Gemini -->
        <div class="chat-panel">
          <h3>
            Gemini
            <span class="panel-actions">
              <button id="geminiSizeDownBtn" class="btn-tiny">A-</button>
              <button id="geminiSizeUpBtn" class="btn-tiny">A+</button>
              <button id="openPersonaGeminiBtn" class="btn-tiny">Промт</button>
              <button id="clearGeminiBtn" class="btn-tiny btn-danger">Clear</button>
            </span>
          </h3>
          <div id="chat-gemini" class="chat-display"></div>
          <div class="input-group">
            <textarea id="input-gemini" placeholder="Спросить Gemini..."></textarea>
            <button id="stopGeminiBtn" class="btn btn-danger hidden" disabled>Stop</button>
            <button id="sendGeminiBtn" class="btn btn-primary">Send</button>
          </div>
        </div>

        <!-- Codex -->
        <div class="chat-panel">
          <h3>
            Codex
            <span class="panel-actions">
              <button id="codexSizeDownBtn" class="btn-tiny">A-</button>
              <button id="codexSizeUpBtn" class="btn-tiny">A+</button>
              <button id="openPersonaCodexBtn" class="btn-tiny">Промт</button>
              <button id="clearCodexBtn" class="btn-tiny btn-danger">Clear</button>
            </span>
          </h3>
          <div id="chat-codex" class="chat-display"></div>
          <div class="input-group">
            <textarea id="input-codex" placeholder="Спросить Codex..."></textarea>
            <button id="stopCodexBtn" class="btn btn-danger hidden" disabled>Stop</button>
            <button id="sendCodexBtn" class="btn btn-primary">Send</button>
          </div>
        </div>

        <!-- Team Lead -->
        <div class="chat-panel full-width">
          <h3>
            Team Lead
            <span class="panel-actions">
              <button id="togetherSizeDownBtn" class="btn-tiny">A-</button>
              <button id="togetherSizeUpBtn" class="btn-tiny">A+</button>
              <button id="openPersonaLeadBtn" class="btn-tiny">Промт</button>
              <button id="clearTogetherBtn" class="btn-tiny btn-danger">Clear</button>
            </span>
          </h3>
          <div id="chat-together" class="chat-display together-display"></div>
          <div class="lead-dialog-actions">
            <button id="openLeadGeminiDialogBtn" class="btn btn-ghost">Lead ↔ Gemini</button>
            <button id="openLeadCodexDialogBtn" class="btn btn-ghost">Lead ↔ Codex</button>
          </div>
          <div class="input-group">
            <textarea id="input-together" placeholder="Запрос для Team Lead..."></textarea>
            <button id="stopTogetherBtn" class="btn btn-danger hidden" disabled>Stop</button>
            <button id="sendTogetherBtn" class="btn btn-primary">Send to Lead</button>
          </div>
        </div>
      </div>
    </main>
  </div>

  <div id="personaModalBackdrop" class="modal-backdrop">
    <div class="modal">
      <h3 id="personaModalTitle">Инструкция</h3>
      <textarea id="personaModalInput" placeholder="Введите персональную инструкцию..."></textarea>
      <div class="modal-actions">
        <button id="personaModalCancelBtn" class="btn btn-ghost">Отмена</button>
        <button id="personaModalSaveBtn" class="btn btn-primary">Сохранить</button>
      </div>
    </div>
  </div>

  <div id="storageModalBackdrop" class="modal-backdrop">
    <div class="modal">
      <h3>Папка проектов</h3>
      <p style="margin:0 0 10px 0;color:var(--sub);font-size:13px;">
        Укажите путь. Существующие проекты будут перенесены в новую папку автоматически.
      </p>
      <textarea id="storagePathInput" placeholder="/Users/you/Desktop/AI office" style="min-height:90px;"></textarea>
      <div class="modal-actions">
        <button id="storageUseDefaultBtn" class="btn btn-ghost">Desktop/AI office</button>
        <button id="storageModalCancelBtn" class="btn btn-ghost">Отмена</button>
        <button id="storageModalSaveBtn" class="btn btn-primary">Сохранить</button>
      </div>
    </div>
  </div>

  <div id="pairDialogBackdrop" class="modal-backdrop">
    <div class="modal">
      <h3 id="pairDialogTitle">Диалог</h3>
      <div id="pairDialogBody" class="chat-display" style="height: 420px;"></div>
      <div class="modal-actions">
        <button id="pairDialogCloseBtn" class="btn btn-ghost">Закрыть</button>
      </div>
    </div>
  </div>

<script>
const geminiChatEl = document.getElementById("chat-gemini");
const codexChatEl = document.getElementById("chat-codex");
const togetherChatEl = document.getElementById("chat-together");
const projectsEl = document.getElementById("projects");
const projectTitleEl = document.getElementById("projectTitle");
const projectStatsEl = document.getElementById("projectStats");
const projectNameInput = document.getElementById("projectNameInput");
const errorsEl = document.getElementById("errors");
const personaModalBackdrop = document.getElementById("personaModalBackdrop");
const personaModalTitle = document.getElementById("personaModalTitle");
const personaModalInput = document.getElementById("personaModalInput");
const personaModalCancelBtn = document.getElementById("personaModalCancelBtn");
const personaModalSaveBtn = document.getElementById("personaModalSaveBtn");
const openStorageBtn = document.getElementById("openStorageBtn");
const storageModalBackdrop = document.getElementById("storageModalBackdrop");
const storagePathInput = document.getElementById("storagePathInput");
const storageUseDefaultBtn = document.getElementById("storageUseDefaultBtn");
const storageModalCancelBtn = document.getElementById("storageModalCancelBtn");
const storageModalSaveBtn = document.getElementById("storageModalSaveBtn");
const openLeadGeminiDialogBtn = document.getElementById("openLeadGeminiDialogBtn");
const openLeadCodexDialogBtn = document.getElementById("openLeadCodexDialogBtn");
const pairDialogBackdrop = document.getElementById("pairDialogBackdrop");
const pairDialogTitle = document.getElementById("pairDialogTitle");
const pairDialogBody = document.getElementById("pairDialogBody");
const pairDialogCloseBtn = document.getElementById("pairDialogCloseBtn");

let selectedProjectId = null;
const inFlight = { gemini: false, codex: false, together: false };
const abortControllers = { gemini: null, codex: null, together: null };
const stopRequested = { gemini: false, codex: false, together: false };
let currentPersonas = { gemini: "", codex: "", lead: "" };
let personaModalModel = null;
let currentStorageRoot = "";
let currentProjectPath = "";
let currentTogetherFlow = [];
const chatSizes = { gemini: 350, codex: 350, together: 300 };
const CHAT_SIZE_MIN = 220;
const CHAT_SIZE_MAX = 760;
const CHAT_SIZE_STEP = 60;

function filterTeamLeadMainFlow(messages) {
  return (messages || []).filter(m => {
    if (!(m.role === "user" || m.role === "lead")) return false;
    const txt = String(m.text || "");
    if (txt.startsWith("[TO GEMINI]") || txt.startsWith("[TO CODEX]")) return false;
    return true;
  });
}

function esc(s){
  if(!s) return "";
  return s.replace(/[&<>"]/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m]));
}

function formatText(text) {
  let html = esc(text);
  // Simple markdown-ish code blocks
  html = html.replace(/```([^\\`]+)```/g, '<pre><code>$1</code></pre>');
  // Simple inline code
  html = html.replace(/`([^\\`]+)`/g, '<code>$1</code>');
  return html;
}

function copyToClipboard(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const oldText = btn.innerHTML;
    btn.innerHTML = '✓';
    setTimeout(() => btn.innerHTML = oldText, 2000);
  });
}

function renderProjects(projects, currentProjectId){
  projectsEl.innerHTML = (projects || []).map(p => `
    <div class="project-card ${p.id === currentProjectId ? "active" : ""}" onclick="selectProject('${p.id}')">
      <div class="name">${esc(p.name)}</div>
      <div class="info">
        <span>${esc(p.updated_at.split(' ')[1])}</span>
        <span>${p.messages_count} msgs</span>
      </div>
      <div class="project-actions">
        <button class="btn-tiny" onclick="event.stopPropagation(); renameProject('${p.id}', '${esc(p.name)}')">Rename</button>
        <button class="btn-tiny btn-danger" onclick="event.stopPropagation(); deleteProject('${p.id}')">Delete</button>
      </div>
    </div>
  `).join("");
}

function renderChat(targetEl, msgs){
  targetEl.innerHTML = (msgs || []).map(m => `
    <div class="message ${m.role}">
      <button class="copy-btn" onclick="copyToClipboard(\`${m.text.replace(/`/g, '\\`').replace(/\\$/g, '\\\\$')}\`, this)">Copy</button>
      <div class="msg-meta">
        <span>${m.role.toUpperCase()}</span>
        <span>${m.timestamp.split(' ')[1]} · ${m.tokens_estimated} tokens</span>
      </div>
      <div class="msg-text">${formatText(m.text)}</div>
    </div>
  `).join("");
  targetEl.scrollTop = targetEl.scrollHeight;
}

function getChatElementByMode(mode) {
  if (mode === "gemini") return geminiChatEl;
  if (mode === "codex") return codexChatEl;
  return togetherChatEl;
}

function setStopButtonVisible(mode, visible) {
  const stopBtn = document.getElementById(`stop${mode.charAt(0).toUpperCase() + mode.slice(1)}Btn`);
  if (!stopBtn) return;
  stopBtn.classList.toggle("hidden", !visible);
  stopBtn.disabled = !visible;
}

function setThinking(mode, enabled) {
  const chatEl = getChatElementByMode(mode);
  let indicator = chatEl.querySelector(".thinking-indicator");
  if (!enabled) {
    if (indicator) indicator.remove();
    return;
  }
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.className = "message thinking-indicator";
    indicator.innerHTML = `<div class="thinking-text">Думаю<span class="dots"><span></span><span></span><span></span></span></div>`;
    chatEl.appendChild(indicator);
  }
  chatEl.scrollTop = chatEl.scrollHeight;
}

function applyChatSizes() {
  const g = document.getElementById("chat-gemini");
  const c = document.getElementById("chat-codex");
  const t = document.getElementById("chat-together");
  if (g) g.style.height = `${chatSizes.gemini}px`;
  if (c) c.style.height = `${chatSizes.codex}px`;
  if (t) t.style.height = `${chatSizes.together}px`;
}

function changeChatSize(mode, delta) {
  const current = chatSizes[mode] || 350;
  const next = Math.max(CHAT_SIZE_MIN, Math.min(CHAT_SIZE_MAX, current + delta));
  chatSizes[mode] = next;
  localStorage.setItem("ai_office_chat_sizes", JSON.stringify(chatSizes));
  applyChatSizes();
}

function loadChatSizes() {
  try {
    const raw = localStorage.getItem("ai_office_chat_sizes");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    ["gemini", "codex", "together"].forEach((k) => {
      const val = Number(parsed[k]);
      if (!Number.isNaN(val) && val >= CHAT_SIZE_MIN && val <= CHAT_SIZE_MAX) {
        chatSizes[k] = val;
      }
    });
  } catch (_) {}
}

function syncThinkingIndicators() {
  ["gemini", "codex", "together"].forEach((mode) => {
    setThinking(mode, inFlight[mode]);
    setStopButtonVisible(mode, inFlight[mode]);
  });
}

function appendOptimisticUserMessage(mode, text) {
  const chatEl = getChatElementByMode(mode);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const msg = document.createElement("div");
  msg.className = "message user";
  msg.innerHTML = `
    <div class="msg-meta">
      <span>USER</span>
      <span>${hh}:${mm}:${ss}</span>
    </div>
    <div class="msg-text">${formatText(text)}</div>
  `;
  chatEl.appendChild(msg);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function render(data){
  if (data.project_id) selectedProjectId = data.project_id;
  currentStorageRoot = data.storage_root || "";
  currentProjectPath = data.project_path || "";
  projectTitleEl.textContent = data.project_name || "Project";
  projectStatsEl.textContent = `Обновлено: ${data.timestamp.split(' ')[1]} · ${data.totals.all_messages} сообщений всего · ${currentProjectPath}`;
  
  renderProjects(data.projects || [], data.project_id);
  
  const personas = data.personas || {};
  currentPersonas = { gemini: personas.gemini || "", codex: personas.codex || "", lead: personas.lead || "" };
  
  const flows = data.flows || {};
  currentTogetherFlow = flows.together || [];
  renderChat(geminiChatEl, flows.gemini || []);
  renderChat(codexChatEl, flows.codex || []);
  renderChat(togetherChatEl, filterTeamLeadMainFlow(currentTogetherFlow));
  syncThinkingIndicators();
  
  const errs = data.errors || [];
  errorsEl.innerHTML = errs.length ? errs.map(e => `<div>${esc(e)}</div>`).join("") : "";
}

function closePairDialog() {
  pairDialogBackdrop.classList.remove("open");
}

function openPairDialog(workerRole) {
  const title = workerRole === "gemini" ? "Диалог Team Lead ↔ Gemini" : "Диалог Team Lead ↔ Codex";
  pairDialogTitle.textContent = title;
  const targetMark = workerRole === "gemini" ? "[TO GEMINI]" : "[TO CODEX]";
  const filtered = (currentTogetherFlow || []).filter((m) => {
    if (m.role === workerRole) return true;
    if (m.role !== "lead") return false;
    const txt = String(m.text || "");
    if (txt.startsWith(targetMark)) return true;
    // Keep only operational lead messages in pair dialogs.
    if (txt.startsWith("[Team Lead]")) return false;
    return false;
  });
  renderChat(pairDialogBody, filtered);
  pairDialogBackdrop.classList.add("open");
}

async function api(path, body = null) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  return apiWithSignal(path, body, controller.signal, timeout);
}

async function apiWithSignal(path, body = null, signal = null, timeoutHandle = null) {
  const options = {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    signal: signal || undefined
  };
  if (body) options.body = JSON.stringify(body);
  try {
    const r = await fetch(path, options);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || "Request failed");
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Слишком долго ждём ответ. Попробуйте снова.");
    throw e;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function loadState(){
  try {
    const q = selectedProjectId ? `?project_id=${encodeURIComponent(selectedProjectId)}` : "";
    const data = await api(`/api/state-all${q}`);
    render(data);
  } catch(e) { errorsEl.textContent = e.message; }
}

function selectProject(id) {
  selectedProjectId = id;
  loadState();
}

async function renameProject(id, oldName) {
  const name = prompt("Новое название:", oldName);
  if (name) render(await api("/api/project/rename", { project_id: id, name }));
}

async function deleteProject(id) {
  if (confirm("Удалить проект?")) render(await api("/api/project/delete", { project_id: id }));
}

function openPersonaModal(model) {
  personaModalModel = model;
  if (model === "gemini") {
    personaModalTitle.textContent = "Инструкция для Gemini";
  } else if (model === "codex") {
    personaModalTitle.textContent = "Инструкция для Codex";
  } else {
    personaModalTitle.textContent = "Инструкция для Team Lead";
  }
  personaModalInput.value = currentPersonas[model] || "";
  personaModalBackdrop.classList.add("open");
  setTimeout(() => personaModalInput.focus(), 0);
}

function closePersonaModal() {
  personaModalBackdrop.classList.remove("open");
  personaModalModel = null;
}

function openStorageModal() {
  storagePathInput.value = currentStorageRoot || "";
  storageModalBackdrop.classList.add("open");
  setTimeout(() => storagePathInput.focus(), 0);
}

function closeStorageModal() {
  storageModalBackdrop.classList.remove("open");
}

async function saveStoragePath() {
  const path = storagePathInput.value.trim();
  if (!path) return;
  const data = await api("/api/storage", { path });
  render(data);
  closeStorageModal();
}

async function pickStoragePathNative() {
  try {
    const picked = await api("/api/storage/pick", { start_path: currentStorageRoot || "" });
    if (picked.cancelled) return;
    if (!picked.path) throw new Error("Не удалось получить путь из системного окна.");
    const data = await api("/api/storage", { path: picked.path });
    render(data);
  } catch (e) {
    // Fallback to in-app modal if native picker is unavailable.
    openStorageModal();
    if (e && e.message) errorsEl.textContent = e.message;
  }
}

async function savePersonaFromModal() {
  if (!personaModalModel) return;
  const data = await api("/api/persona", {
    project_id: selectedProjectId,
    model: personaModalModel,
    prompt: personaModalInput.value
  });
  render(data);
  closePersonaModal();
}

async function sendMessage(mode){
  if (inFlight[mode]) return;
  const requestProjectId = selectedProjectId;
  const inputEl = document.getElementById(`input-${mode}`);
  const btn = document.getElementById(`send${mode.charAt(0).toUpperCase() + mode.slice(1)}Btn`);
  const text = inputEl.value.trim();
  if(!text) return;

  appendOptimisticUserMessage(mode, text);
  inputEl.value = "";
  inputEl.style.height = 'auto';
  inFlight[mode] = true;
  stopRequested[mode] = false;
  const stopBtn = document.getElementById(`stop${mode.charAt(0).toUpperCase() + mode.slice(1)}Btn`);
  if (stopBtn) {
    stopBtn.classList.remove("hidden");
    stopBtn.disabled = false;
  }
  setThinking(mode, true);
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "...";
  errorsEl.textContent = "";

  const controller = new AbortController();
  const requestTimeoutMs = mode === "together" ? 900000 : 180000;
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  abortControllers[mode] = controller;
  try {
    const data = await apiWithSignal("/api/chat", { mode, text, project_id: requestProjectId }, controller.signal, timeout);
    // Keep UI on the project user is currently viewing.
    // If response belongs to another project (user switched while waiting),
    // do not force navigation back.
    if (selectedProjectId && requestProjectId && selectedProjectId !== requestProjectId) {
      await loadState();
    } else {
      render(data);
    }
  } catch(e) {
    if (!stopRequested[mode]) {
      errorsEl.textContent = e.message;
      try { await loadState(); } catch (_) {}
    }
  }
  finally {
    abortControllers[mode] = null;
    inFlight[mode] = false;
    setThinking(mode, false);
    btn.disabled = false;
    btn.textContent = originalText;
    if (stopBtn) stopBtn.disabled = true;
    if (stopBtn) stopBtn.classList.add("hidden");
  }
}

async function stopGeneration(mode) {
  if (!inFlight[mode]) return;
  stopRequested[mode] = true;
  const ctrl = abortControllers[mode];
  if (ctrl) {
    try { ctrl.abort(); } catch (_) {}
  }
  try {
    await api("/api/stop", { mode, project_id: selectedProjectId });
  } catch (_) {}
  inFlight[mode] = false;
  setThinking(mode, false);
  const sendBtn = document.getElementById(`send${mode.charAt(0).toUpperCase() + mode.slice(1)}Btn`);
  const stopBtn = document.getElementById(`stop${mode.charAt(0).toUpperCase() + mode.slice(1)}Btn`);
  if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = mode === "together" ? "Send to Lead" : "Send"; }
  if (stopBtn) {
    stopBtn.disabled = true;
    stopBtn.classList.add("hidden");
  }
}

// Auto-expand textareas
document.querySelectorAll('textarea').forEach(el => {
  el.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
  });
});

// Event Listeners
document.getElementById("createProjectBtn").onclick = async () => {
  const name = projectNameInput.value.trim();
  render(await api("/api/project", { name }));
  projectNameInput.value = "";
};
document.getElementById("openPersonaGeminiBtn").onclick = () => openPersonaModal("gemini");
document.getElementById("openPersonaCodexBtn").onclick = () => openPersonaModal("codex");
document.getElementById("openPersonaLeadBtn").onclick = () => openPersonaModal("lead");
openStorageBtn.onclick = () => pickStoragePathNative();
personaModalCancelBtn.onclick = closePersonaModal;
personaModalSaveBtn.onclick = () => savePersonaFromModal().catch(e => { errorsEl.textContent = e.message; });
personaModalBackdrop.onclick = (e) => { if (e.target === personaModalBackdrop) closePersonaModal(); };
personaModalInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    savePersonaFromModal().catch(err => { errorsEl.textContent = err.message; });
  }
});
storageUseDefaultBtn.onclick = () => {
  storagePathInput.value = "~/Desktop/AI office";
};
storageModalCancelBtn.onclick = closeStorageModal;
storageModalSaveBtn.onclick = () => saveStoragePath().catch(e => { errorsEl.textContent = e.message; });
storageModalBackdrop.onclick = (e) => { if (e.target === storageModalBackdrop) closeStorageModal(); };
storagePathInput.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    saveStoragePath().catch(err => { errorsEl.textContent = err.message; });
  }
});
openLeadGeminiDialogBtn.onclick = () => openPairDialog("gemini");
openLeadCodexDialogBtn.onclick = () => openPairDialog("codex");
pairDialogCloseBtn.onclick = closePairDialog;
pairDialogBackdrop.onclick = (e) => { if (e.target === pairDialogBackdrop) closePairDialog(); };

document.getElementById("sendGeminiBtn").onclick = () => sendMessage("gemini");
document.getElementById("sendCodexBtn").onclick = () => sendMessage("codex");
document.getElementById("sendTogetherBtn").onclick = () => sendMessage("together");
document.getElementById("geminiSizeDownBtn").onclick = () => changeChatSize("gemini", -CHAT_SIZE_STEP);
document.getElementById("geminiSizeUpBtn").onclick = () => changeChatSize("gemini", CHAT_SIZE_STEP);
document.getElementById("codexSizeDownBtn").onclick = () => changeChatSize("codex", -CHAT_SIZE_STEP);
document.getElementById("codexSizeUpBtn").onclick = () => changeChatSize("codex", CHAT_SIZE_STEP);
document.getElementById("togetherSizeDownBtn").onclick = () => changeChatSize("together", -CHAT_SIZE_STEP);
document.getElementById("togetherSizeUpBtn").onclick = () => changeChatSize("together", CHAT_SIZE_STEP);
document.getElementById("stopGeminiBtn").onclick = () => stopGeneration("gemini");
document.getElementById("stopCodexBtn").onclick = () => stopGeneration("codex");
document.getElementById("stopTogetherBtn").onclick = () => stopGeneration("together");

document.getElementById("clearGeminiBtn").onclick = () => api("/api/reset", { mode: "gemini", project_id: selectedProjectId }).then(render);
document.getElementById("clearCodexBtn").onclick = () => api("/api/reset", { mode: "codex", project_id: selectedProjectId }).then(render);
document.getElementById("clearTogetherBtn").onclick = () => api("/api/reset", { mode: "together", project_id: selectedProjectId }).then(render);

// Enter to send
function bindEnterToSend(inputId, mode) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.addEventListener("keydown", (e) => {
    if (e.isComposing) return;
    const isEnter = e.key === "Enter" || e.code === "Enter" || e.code === "NumpadEnter";
    if (isEnter && !e.shiftKey) {
      e.preventDefault();
      sendMessage(mode);
    }
  });
}

bindEnterToSend("input-gemini", "gemini");
bindEnterToSend("input-codex", "codex");
bindEnterToSend("input-together", "together");

loadChatSizes();
applyChatSizes();
loadState();
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    state: AIOfficeState = None  # type: ignore

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_html(self, status: int, html: str) -> None:
        data = html.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def log_message(self, fmt: str, *args) -> None:
        # Keep server stdout clean; interactions are logged in file.
        return

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/":
            self._send_html(200, HTML)
            return
        if parsed.path == "/api/state-all":
            query = parse_qs(parsed.query)
            project_id = (query.get("project_id") or [None])[0]
            with self.state.lock:
                snap = self.state.snapshot_all(project_id)
            self._send_json(200, snap)
            return
        if parsed.path == "/api/state":
            query = parse_qs(parsed.query)
            mode = (query.get("mode") or ["together"])[0]
            project_id = (query.get("project_id") or [None])[0]
            if mode not in ("together", "gemini", "codex"):
                self._send_json(400, {"error": "Invalid mode."})
                return
            with self.state.lock:
                snap = self.state.snapshot(project_id, mode)
            self._send_json(200, snap)
            return
        self._send_json(404, {"error": "Not found."})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/chat":
            self.handle_chat()
            return
        if self.path == "/api/reset":
            self.handle_reset()
            return
        if self.path == "/api/stop":
            self.handle_stop()
            return
        if self.path == "/api/project":
            self.handle_project_create()
            return
        if self.path == "/api/project/rename":
            self.handle_project_rename()
            return
        if self.path == "/api/project/delete":
            self.handle_project_delete()
            return
        if self.path == "/api/storage":
            self.handle_storage_set()
            return
        if self.path == "/api/storage/pick":
            self.handle_storage_pick()
            return
        if self.path == "/api/persona":
            self.handle_persona()
            return
        self._send_json(404, {"error": "Not found."})

    def handle_stop(self) -> None:
        try:
            body = self._read_json()
        except Exception:
            self._send_json(400, {"error": "Invalid JSON."})
            return
        mode = body.get("mode")
        project_id = body.get("project_id")
        if mode not in ("together", "gemini", "codex"):
            self._send_json(400, {"error": "Invalid mode."})
            return
        if not project_id:
            with self.state.lock:
                project_id = self.state.get_project(None)["id"]
        self.state.request_stop(project_id, mode)
        self._send_json(200, {"ok": True, "project_id": project_id, "mode": mode})

    def handle_project_create(self) -> None:
        try:
            body = self._read_json()
        except Exception:
            self._send_json(400, {"error": "Invalid JSON."})
            return
        name = (body.get("name") or "").strip() or "New project"
        with self.state.lock:
            project = self.state.create_project(name)
            snap = self.state.snapshot_all(project["id"])
        self._send_json(200, snap)

    def handle_project_rename(self) -> None:
        try:
            body = self._read_json()
        except Exception:
            self._send_json(400, {"error": "Invalid JSON."})
            return
        project_id = body.get("project_id")
        name = body.get("name")
        if not project_id:
            self._send_json(400, {"error": "project_id is required"})
            return
        try:
            with self.state.lock:
                project = self.state.rename_project(project_id, name)
                snap = self.state.snapshot_all(project["id"])
        except KeyError:
            self._send_json(404, {"error": "Project not found"})
            return
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
            return
        self._send_json(200, snap)

    def handle_project_delete(self) -> None:
        try:
            body = self._read_json()
        except Exception:
            self._send_json(400, {"error": "Invalid JSON."})
            return
        project_id = body.get("project_id")
        if not project_id:
            self._send_json(400, {"error": "project_id is required"})
            return
        try:
            with self.state.lock:
                project = self.state.delete_project(project_id)
                snap = self.state.snapshot_all(project["id"])
        except KeyError:
            self._send_json(404, {"error": "Project not found"})
            return
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
            return
        self._send_json(200, snap)

    def handle_storage_set(self) -> None:
        try:
            body = self._read_json()
        except Exception:
            self._send_json(400, {"error": "Invalid JSON."})
            return
        path = (body.get("path") or "").strip()
        if not path:
            self._send_json(400, {"error": "path is required"})
            return
        try:
            with self.state.lock:
                project = self.state.set_storage_root(path)
                snap = self.state.snapshot_all(project["id"])
        except Exception as exc:
            self._send_json(400, {"error": f"Failed to set storage path: {exc}"})
            return
        self._send_json(200, snap)

    def handle_storage_pick(self) -> None:
        if sys.platform != "darwin":
            self._send_json(400, {"error": "Native folder picker is only available on macOS."})
            return
        try:
            body = self._read_json()
        except Exception:
            body = {}
        start_path = (body.get("start_path") or str(Path.home())).strip()
        start_path = str(Path(start_path).expanduser())
        prompt = "Выберите папку для хранения проектов AI Office"
        script = (
            f'set startFolder to POSIX file "{start_path}"\n'
            f'set pickedFolder to choose folder with prompt "{prompt}" default location startFolder\n'
            "POSIX path of pickedFolder"
        )
        try:
            proc = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
        except Exception as exc:
            self._send_json(500, {"error": f"Failed to open native picker: {exc}"})
            return
        if proc.returncode != 0:
            err = (proc.stderr or "").strip()
            # -128: user canceled.
            if "-128" in err:
                self._send_json(200, {"cancelled": True})
                return
            self._send_json(500, {"error": f"Native picker failed: {err or 'unknown error'}"})
            return
        picked = (proc.stdout or "").strip()
        if not picked:
            self._send_json(200, {"cancelled": True})
            return
        self._send_json(200, {"path": picked})

    def handle_persona(self) -> None:
        try:
            body = self._read_json()
        except Exception:
            self._send_json(400, {"error": "Invalid JSON."})
            return
        project_id = body.get("project_id")
        model = body.get("model")
        prompt = body.get("prompt", "")
        if model not in ("gemini", "codex", "lead"):
            self._send_json(400, {"error": "model must be gemini, codex or lead"})
            return
        with self.state.lock:
            project = self.state.set_persona(project_id, model, prompt)
            snap = self.state.snapshot_all(project["id"])
        self._send_json(200, snap)

    def handle_reset(self) -> None:
        try:
            body = self._read_json()
        except Exception:
            self._send_json(400, {"error": "Invalid JSON."})
            return
        mode = body.get("mode", "together")
        project_id = body.get("project_id")
        with self.state.lock:
            if mode == "all":
                self.state.reset_all(project_id)
                snap = self.state.snapshot_all(project_id)
            elif mode in ("together", "gemini", "codex"):
                self.state.reset_mode(project_id, mode)
                snap = self.state.snapshot_all(project_id)
            else:
                self._send_json(400, {"error": "Invalid mode."})
                return
        self._send_json(200, snap)

    def handle_chat(self) -> None:
        try:
            body = self._read_json()
        except Exception:
            self._send_json(400, {"error": "Invalid JSON."})
            return

        mode = body.get("mode")
        project_id = body.get("project_id")
        text = (body.get("text") or "").strip()
        if mode not in ("together", "gemini", "codex"):
            self._send_json(400, {"error": "Invalid mode."})
            return
        if not text:
            self._send_json(400, {"error": "Text is required."})
            return

        with self.state.lock:
            project = self.state.get_project(project_id)
            project_id = project["id"]
            history = list(project["flows"][mode])
            personas = project.get("personas", {"gemini": "", "codex": "", "lead": ""})
            project_path = project.get("path", "")
            self.state.clear_stop_request(project_id, mode)
            self.state.add_message(project_id, mode, "user", text)

            if mode == "gemini":
                if shutil.which("gemini") is None:
                    snap = self.state.snapshot_all(project_id)
                    self._send_json(503, {"error": "gemini command is unavailable.", **snap})
                    return
                prompt = model_prompt(
                    "Gemini",
                    mode,
                    text,
                    history,
                    custom_instruction=personas.get("gemini", ""),
                    workdir=project_path,
                )
                self.state.totals["by_flow"]["gemini_prompt_tokens"] += estimate_tokens(prompt)
                ok, out = self.state.call_model(project_id, mode, "gemini", prompt)
                if not ok:
                    if out.startswith("[STOPPED]"):
                        self.state.add_message(project_id, mode, "gemini", out)
                        self.state.clear_stop_request(project_id, mode)
                        snap = self.state.snapshot_all(project_id)
                        self._send_json(200, {"stopped": True, **snap})
                        return
                    self.state.add_message(project_id, mode, "gemini", out)
                    snap = self.state.snapshot_all(project_id)
                    self._send_json(500, {"error": out, **snap})
                    return
                self.state.totals["by_flow"]["gemini_output_tokens"] += estimate_tokens(out)
                self.state.add_message(project_id, mode, "gemini", out)

            elif mode == "codex":
                if shutil.which("codex") is None:
                    snap = self.state.snapshot_all(project_id)
                    self._send_json(503, {"error": "codex command is unavailable.", **snap})
                    return
                prompt = model_prompt(
                    "Codex",
                    mode,
                    text,
                    history,
                    custom_instruction=personas.get("codex", ""),
                    workdir=project_path,
                )
                self.state.totals["by_flow"]["codex_prompt_tokens"] += estimate_tokens(prompt)
                ok, out = self.state.call_model(project_id, mode, "codex", prompt)
                if not ok:
                    if out.startswith("[STOPPED]"):
                        self.state.add_message(project_id, mode, "codex", out)
                        self.state.clear_stop_request(project_id, mode)
                        snap = self.state.snapshot_all(project_id)
                        self._send_json(200, {"stopped": True, **snap})
                        return
                    self.state.add_message(project_id, mode, "codex", out)
                    snap = self.state.snapshot_all(project_id)
                    self._send_json(500, {"error": out, **snap})
                    return
                self.state.totals["by_flow"]["codex_output_tokens"] += estimate_tokens(out)
                self.state.add_message(project_id, mode, "codex", out)

            else:
                relay = relay_target(text)
                if relay:
                    worker_name = "Gemini" if relay == "gemini" else "Codex"
                    worker_cmd = relay
                    if shutil.which(worker_cmd) is None:
                        l_out = f"[Team Lead] Не могу передать сообщение: {worker_name} сейчас недоступен."
                        self.state.add_message(project_id, mode, "lead", l_out)
                        self.state.clear_stop_request(project_id, mode)
                        snap = self.state.snapshot_all(project_id)
                        self._send_json(200, snap)
                        return
                    relay_history = history_for_worker(
                        list(self.state.get_project(project_id)["flows"][mode]),
                        relay,
                    )
                    relay_bridge = (
                        "Task source: Team Lead relay.\n"
                        "This is only message forwarding, not a development task.\n"
                        "Reply in one short friendly sentence (max 12 words), no lists, no plan, no code.\n"
                        "If user sent greeting, just greet back briefly."
                    )
                    relay_prompt = model_prompt(
                        "Gemini" if relay == "gemini" else "Codex",
                        mode,
                        text,
                        relay_history[-3:],
                        custom_instruction=personas.get(relay, ""),
                        bridge=relay_bridge,
                        workdir=project_path,
                    )
                    self.state.add_message(
                        project_id,
                        mode,
                        "lead",
                        f"[TO {worker_name.upper()}] {text}",
                    )
                    if relay == "gemini":
                        self.state.totals["by_flow"]["gemini_prompt_tokens"] += estimate_tokens(relay_prompt)
                    else:
                        self.state.totals["by_flow"]["codex_prompt_tokens"] += estimate_tokens(relay_prompt)

                    r_ok, r_out = self.state.call_model(project_id, mode, worker_cmd, relay_prompt)
                    self.state.add_message(project_id, mode, relay, r_out)
                    if r_out.startswith("[STOPPED]"):
                        self.state.clear_stop_request(project_id, mode)
                        snap = self.state.snapshot_all(project_id)
                        self._send_json(200, {"stopped": True, **snap})
                        return
                    if r_ok:
                        if relay == "gemini":
                            self.state.totals["by_flow"]["gemini_output_tokens"] += estimate_tokens(r_out)
                        else:
                            self.state.totals["by_flow"]["codex_output_tokens"] += estimate_tokens(r_out)
                        short = " ".join((r_out or "").split())
                        if len(short) > 160:
                            short = short[:157] + "..."
                        l_out = f"[Team Lead] Передал сообщение {worker_name}. Ответ: {short}"
                    else:
                        l_out = f"[Team Lead] Сообщение {worker_name} передал, но ответ с ошибкой: {r_out}"
                    self.state.add_message(project_id, mode, "lead", l_out)
                    self.state.clear_stop_request(project_id, mode)
                    snap = self.state.snapshot_all(project_id)
                    self._send_json(200, snap)
                    return

                if is_smalltalk(text):
                    l_history = list(self.state.get_project(project_id)["flows"][mode])
                    l_prompt = lead_prompt(
                        text,
                        l_history,
                        custom_instruction=personas.get("lead", ""),
                    )
                    self.state.totals["by_flow"]["lead_prompt_tokens"] += estimate_tokens(l_prompt)
                    l_ok, l_out = self.state.call_team_lead(project_id, mode, l_prompt)
                    if not l_ok:
                        if l_out.startswith("[STOPPED]"):
                            self.state.add_message(project_id, mode, "lead", l_out)
                            self.state.clear_stop_request(project_id, mode)
                            snap = self.state.snapshot_all(project_id)
                            self._send_json(200, {"stopped": True, **snap})
                            return
                        l_out = "Привет! Чем помочь по проекту сейчас?"
                    l_out = "\n".join(
                        ln for ln in (l_out or "").splitlines()
                        if "ЗАДАЧА ЗАВЕРШЕНА" not in ln.upper()
                    ).strip() or "Привет! Чем помочь по проекту сейчас?"
                    self.state.totals["by_flow"]["lead_output_tokens"] += estimate_tokens(l_out)
                    self.state.add_message(project_id, mode, "lead", l_out)
                    self.state.clear_stop_request(project_id, mode)
                    snap = self.state.snapshot_all(project_id)
                    self._send_json(200, snap)
                    return

                if is_management_question(text):
                    mgmt_prompt = (
                        "Management/organizational question from user:\n"
                        f"{text}\n\n"
                        "Important:\n"
                        "- Do NOT delegate this to workers.\n"
                        "- Answer as Team Lead only.\n"
                        "- Keep answer short and practical.\n"
                        "- Give one clear recommendation and one next step."
                    )
                    l_history = list(self.state.get_project(project_id)["flows"][mode])
                    l_prompt = lead_prompt(
                        mgmt_prompt,
                        l_history,
                        custom_instruction=personas.get("lead", ""),
                    )
                    self.state.totals["by_flow"]["lead_prompt_tokens"] += estimate_tokens(l_prompt)
                    l_ok, l_out = self.state.call_team_lead(project_id, mode, l_prompt)
                    if not l_ok:
                        if l_out.startswith("[STOPPED]"):
                            self.state.add_message(project_id, mode, "lead", l_out)
                            self.state.clear_stop_request(project_id, mode)
                            snap = self.state.snapshot_all(project_id)
                            self._send_json(200, {"stopped": True, **snap})
                            return
                        l_out = "Сначала фиксируем требования и архитектуру, потом запускаем блокирующие задачи."
                    self.state.totals["by_flow"]["lead_output_tokens"] += estimate_tokens(l_out)
                    self.state.add_message(project_id, mode, "lead", l_out)
                    self.state.clear_stop_request(project_id, mode)
                    snap = self.state.snapshot_all(project_id)
                    self._send_json(200, snap)
                    return

                wants_front, wants_back = detect_targets(text)
                delivery_mode = is_delivery_request(text)
                # If this is a "build/finish app" request, run both workers by default,
                # unless user explicitly constrained scope by keywords in detect_targets.
                if delivery_mode and (wants_front ^ wants_back):
                    if "только фронт" not in text.lower() and "only frontend" not in text.lower() and "только бэк" not in text.lower() and "only backend" not in text.lower():
                        wants_front, wants_back = True, True
                worker_reports: list[str] = []
                had_worker_error = False
                workers_with_changes = 0
                workers_called = 0

                if wants_front:
                    workers_called += 1
                    if shutil.which("gemini") is None:
                        g_out = "[ERROR] Gemini CLI is unavailable for frontend task."
                        had_worker_error = True
                        self.state.add_message(project_id, mode, "gemini", g_out)
                        worker_reports.append(f"Gemini(frontend): {g_out}")
                    else:
                        g_history = history_for_worker(
                            list(self.state.get_project(project_id)["flows"][mode]),
                            "gemini",
                        )
                        g_bridge = (
                            "Task source: Team Lead.\n"
                            "Role: Frontend specialist.\n"
                            "Focus on UI/UX/client-side implementation only.\n"
                            "You are in EXECUTION mode: apply real file changes in the project directory now.\n"
                            "Do not return only theory.\n"
                            "Response format:\n"
                            "STATUS: DONE | IN_PROGRESS | BLOCKED\n"
                            "CHANGED_FILES:\n"
                            "- relative/path\n"
                            "SUMMARY: short\n"
                            "NEXT_STEP: short"
                        )
                        g_prompt = model_prompt(
                            "Gemini",
                            mode,
                            text,
                            g_history,
                            custom_instruction=personas.get("gemini", ""),
                            bridge=g_bridge,
                            workdir=project_path,
                        )
                        self.state.totals["by_flow"]["gemini_prompt_tokens"] += estimate_tokens(g_prompt)
                        g_before = collect_project_fingerprint(project_path) if delivery_mode else {}
                        g_ok, g_out = self.state.call_model(project_id, mode, "gemini", g_prompt)
                        g_after = collect_project_fingerprint(project_path) if delivery_mode else {}
                        self.state.add_message(project_id, mode, "gemini", g_out)
                        if g_out.startswith("[STOPPED]"):
                            self.state.clear_stop_request(project_id, mode)
                            snap = self.state.snapshot_all(project_id)
                            self._send_json(200, {"stopped": True, **snap})
                            return
                        if g_ok:
                            self.state.totals["by_flow"]["gemini_output_tokens"] += estimate_tokens(g_out)
                            if delivery_mode:
                                g_diff = summarize_project_changes(g_before, g_after)
                                if int(g_diff["total"]) > 0:
                                    workers_with_changes += 1
                                else:
                                    had_worker_error = True
                                g_changes = (
                                    f"\nFilesystem changes detected: {g_diff['total']}\n"
                                    + "\n".join(g_diff["preview"])
                                    if g_diff["preview"]
                                    else f"\nFilesystem changes detected: {g_diff['total']}"
                                )
                            else:
                                g_changes = ""
                        else:
                            had_worker_error = True
                            g_changes = ""
                        worker_reports.append(f"Gemini(frontend):\n{g_out}{g_changes}")

                if wants_back:
                    workers_called += 1
                    if shutil.which("codex") is None:
                        c_out = "[ERROR] Codex CLI is unavailable for backend task."
                        had_worker_error = True
                        self.state.add_message(project_id, mode, "codex", c_out)
                        worker_reports.append(f"Codex(backend): {c_out}")
                    else:
                        c_history = history_for_worker(
                            list(self.state.get_project(project_id)["flows"][mode]),
                            "codex",
                        )
                        c_bridge = (
                            "Task source: Team Lead.\n"
                            "Role: Backend specialist.\n"
                            "Focus on server/API/data/security/backend implementation only.\n"
                            "You are in EXECUTION mode: apply real file changes in the project directory now.\n"
                            "Do not return only theory.\n"
                            "Response format:\n"
                            "STATUS: DONE | IN_PROGRESS | BLOCKED\n"
                            "CHANGED_FILES:\n"
                            "- relative/path\n"
                            "SUMMARY: short\n"
                            "NEXT_STEP: short"
                        )
                        c_prompt = model_prompt(
                            "Codex",
                            mode,
                            text,
                            c_history,
                            custom_instruction=personas.get("codex", ""),
                            bridge=c_bridge,
                            workdir=project_path,
                        )
                        self.state.totals["by_flow"]["codex_prompt_tokens"] += estimate_tokens(c_prompt)
                        c_before = collect_project_fingerprint(project_path) if delivery_mode else {}
                        c_ok, c_out = self.state.call_model(project_id, mode, "codex", c_prompt)
                        c_after = collect_project_fingerprint(project_path) if delivery_mode else {}
                        self.state.add_message(project_id, mode, "codex", c_out)
                        if c_out.startswith("[STOPPED]"):
                            self.state.clear_stop_request(project_id, mode)
                            snap = self.state.snapshot_all(project_id)
                            self._send_json(200, {"stopped": True, **snap})
                            return
                        if c_ok:
                            self.state.totals["by_flow"]["codex_output_tokens"] += estimate_tokens(c_out)
                            if delivery_mode:
                                c_diff = summarize_project_changes(c_before, c_after)
                                if int(c_diff["total"]) > 0:
                                    workers_with_changes += 1
                                else:
                                    had_worker_error = True
                                c_changes = (
                                    f"\nFilesystem changes detected: {c_diff['total']}\n"
                                    + "\n".join(c_diff["preview"])
                                    if c_diff["preview"]
                                    else f"\nFilesystem changes detected: {c_diff['total']}"
                                )
                            else:
                                c_changes = ""
                        else:
                            had_worker_error = True
                            c_changes = ""
                        worker_reports.append(f"Codex(backend):\n{c_out}{c_changes}")

                lead_input = (
                    f"User request:\n{text}\n\n"
                    f"Routing decision:\n"
                    f"- frontend to Gemini: {'yes' if wants_front else 'no'}\n"
                    f"- backend to Codex: {'yes' if wants_back else 'no'}\n\n"
                    "Worker responses:\n"
                    + ("\n\n".join(worker_reports) if worker_reports else "No worker responses.")
                    + "\n\n"
                    f"Workers called: {workers_called}\n"
                    f"Workers with filesystem changes: {workers_with_changes}\n\n"
                    "Critical rule: if filesystem changes are 0 for any called worker, "
                    "do not mark task as completed.\n"
                    "Respond to the user with a concise merged update and next action."
                )
                l_history = list(self.state.get_project(project_id)["flows"][mode])
                l_prompt = lead_prompt(
                    lead_input,
                    l_history,
                    custom_instruction=personas.get("lead", ""),
                )
                self.state.totals["by_flow"]["lead_prompt_tokens"] += estimate_tokens(l_prompt)
                l_ok, l_out = self.state.call_team_lead(project_id, mode, l_prompt)
                if not l_ok:
                    if l_out.startswith("[STOPPED]"):
                        self.state.add_message(project_id, mode, "lead", l_out)
                        self.state.clear_stop_request(project_id, mode)
                        snap = self.state.snapshot_all(project_id)
                        self._send_json(200, {"stopped": True, **snap})
                        return
                    l_out = fallback_lead_reply(text, worker_reports, had_worker_error)
                    self.state.add_message(project_id, mode, "lead", l_out)
                    snap = self.state.snapshot_all(project_id)
                    self._send_json(200, snap)
                    return
                self.state.totals["by_flow"]["lead_output_tokens"] += estimate_tokens(l_out)
                if had_worker_error:
                    l_out = "[Team Lead] Есть ошибки в ответах исполнителей, см. выше.\n\n" + l_out
                if delivery_mode and workers_called > 0 and workers_with_changes < workers_called:
                    l_out = (
                        "[Team Lead] Задача еще не завершена: не все исполнители внесли изменения в файлы проекта.\n"
                        "Я уже зафиксировал это как блокер и продолжу только с режимом реального исполнения.\n\n"
                        + l_out
                    )
                self.state.add_message(project_id, mode, "lead", l_out)

            self.state.clear_stop_request(project_id, mode)
            snap = self.state.snapshot_all(project_id)
            self._send_json(200, snap)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AI Office local web app")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SEC)
    parser.add_argument("--log-file", default=DEFAULT_LOG_FILE)
    return parser.parse_args()


def main() -> int:
    load_local_env()
    args = parse_args()
    log_path = Path(args.log_file).resolve()
    state = AIOfficeState(log_path=log_path, timeout_sec=args.timeout)
    Handler.state = state

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"AI Office app started at http://{args.host}:{args.port}")
    print(f"Log file: {log_path}")
    print("Modes: together(team lead) | gemini | codex")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    print("AI Office app stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
