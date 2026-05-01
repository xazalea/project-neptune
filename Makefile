# Neptune WASM Unikernel - Build System
# Requires: wasm-pack, cargo, python3 (for dev server)

.PHONY: all build dev clean test wasm-build wasm-opt serve

# Default target
all: wasm-build

# Build the WASM kernel with wasm-pack
wasm-build:
	@echo "Building Neptune WASM kernel..."
	wasm-pack build --target web --out-dir pkg --no-typescript
	@echo "WASM build complete. Output in ./pkg/"

# Build with release optimizations
wasm-release:
	@echo "Building Neptune WASM kernel (release)..."
	wasm-pack build --target web --out-dir pkg --no-typescript --release
	@echo "Release build complete."

# Optimize WASM binary (requires wasm-opt from binaryen)
wasm-opt:
	@if command -v wasm-opt >/dev/null 2>&1; then \
		wasm-opt -O3 -o pkg/neptune_kernel_bg.wasm pkg/neptune_kernel_bg.wasm; \
		echo "WASM optimized."; \
	else \
		echo "wasm-opt not found. Install binaryen for optimization."; \
	fi

# Development server (Python 3)
serve:
	@echo "Starting development server on http://localhost:8080"
	@echo "Navigate to: http://localhost:8080/index.html"
	python3 -m http.server 8080

# Serve with HTTPS (requires mkcert or self-signed cert)
serve-https:
	@echo "Starting HTTPS server on https://localhost:8443"
	@echo "Required for Service Worker registration!"
	python3 -c "
import http.server, ssl, socketserver
ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
ctx.load_cert_chain('server.pem', 'server-key.pem')
server = socketserver.TCPServer(('0.0.0.0', 8443), http.server.SimpleHTTPRequestHandler)
server.socket = ctx.wrap_socket(server.socket, server_side=True)
print('HTTPS server running on https://localhost:8443')
server.serve_forever()
" 2>/dev/null || echo "Run 'make certs' first"

# Generate self-signed certificates for HTTPS testing
certs:
	openssl req -x509 -newkey rsa:2048 -keyout server-key.pem -out server.pem -days 7 -nodes -subj "/CN=localhost"
	@echo "Certificates generated. Use 'make serve-https' to test."

# Development mode: watch and rebuild
watch:
	@echo "Watching for changes... (requires cargo-watch: cargo install cargo-watch)"
	cargo watch -i pkg -s "wasm-pack build --target web --out-dir pkg --no-typescript"

# Run tests
test:
	@echo "Running Rust tests..."
	cargo test

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	cargo clean
	rm -rf pkg/
	rm -rf target/

# Full dev setup (build + serve)
dev: wasm-build serve

# Generate documentation
docs:
	cargo doc --no-deps
	@echo "Documentation generated in target/doc/"

# Build distribution package
dist: wasm-release wasm-opt
	@echo "Building distribution package..."
	mkdir -p dist
	cp -r pkg dist/
	cp index.html dist/
	cp bootloader.svg dist/
	cp sw.js dist/
	cp vfs-bridge.js dist/
	@echo "Distribution ready in ./dist/"
