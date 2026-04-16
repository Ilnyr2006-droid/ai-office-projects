export class XMLParser {
  parse(xml) {
    const root = new XmlNode("root");
    const stack = [root];
    const tokenPattern = /<[^>]+>|[^<]+/g;
    let match;

    while ((match = tokenPattern.exec(xml))) {
      const token = match[0];

      if (token.startsWith("<?") || token.startsWith("<!")) {
        continue;
      }

      if (token.startsWith("</")) {
        stack.pop();
        continue;
      }

      if (token.startsWith("<")) {
        const selfClosing = token.endsWith("/>");
        const inner = token.slice(1, selfClosing ? -2 : -1).trim();
        const spaceIndex = inner.search(/\s/);
        const rawName = spaceIndex === -1 ? inner : inner.slice(0, spaceIndex);
        const attrSource = spaceIndex === -1 ? "" : inner.slice(spaceIndex + 1);
        const node = new XmlNode(stripPrefix(rawName), parseAttributes(attrSource));
        stack.at(-1)?.children.push(node);

        if (!selfClosing) {
          stack.push(node);
        }

        continue;
      }

      const text = decodeXmlEntities(token);
      if (text.trim()) {
        stack.at(-1).text += text;
      }
    }

    return root;
  }
}

class XmlNode {
  constructor(name, attributes = {}) {
    this.name = name;
    this.attributes = attributes;
    this.children = [];
    this.text = "";
  }

  attr(name) {
    return this.attributes[name] || this.attributes[stripPrefix(name)] || "";
  }

  find(path) {
    return this.findAll(path)[0] || null;
  }

  findAll(path) {
    const parts = path.split("/").filter(Boolean).map(stripPrefix);
    let current = [this];

    for (const part of parts) {
      current = current.flatMap((node) => node.children.filter((child) => child.name === part));
    }

    return current;
  }
}

function parseAttributes(input) {
  const attributes = {};
  const pattern = /([^\s=]+)\s*=\s*"([^"]*)"/g;
  let match;

  while ((match = pattern.exec(input))) {
    attributes[stripPrefix(match[1])] = decodeXmlEntities(match[2]);
  }

  return attributes;
}

function stripPrefix(name) {
  return String(name || "").split(":").at(-1);
}

function decodeXmlEntities(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
