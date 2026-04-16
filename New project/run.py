from app.main import create_server


if __name__ == "__main__":
    server = create_server()
    print(f"Car Store MVP API running on http://{server.server_address[0]}:{server.server_address[1]}")
    server.serve_forever()
