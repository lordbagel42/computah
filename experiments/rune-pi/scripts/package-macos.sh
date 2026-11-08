#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export PATH="$HOME/.cargo/bin:$PATH"
cd "$ROOT"
pnpm install --ignore-workspace --lockfile-dir . --frozen-lockfile --ignore-scripts
pnpm test
cargo build --locked
APP="$ROOT/dist/Computah.app"
PI=${PI_BIN:-$(command -v pi)}
NODE=$(command -v node)
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp target/debug/computah-rune-pi "$APP/Contents/MacOS/Computah"
cp layout.json "$APP/Contents/Resources/layout.json"
cat > "$APP/Contents/MacOS/launch" <<EOF
#!/bin/sh
export PATH="$(dirname "$PI"):$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
export COMPUTAH_PROJECT_ROOT="$ROOT"
CONTENTS=\$(CDPATH= cd -- "\$(dirname -- "\$0")/.." && pwd)
cd "\$COMPUTAH_PROJECT_ROOT"
exec "\$CONTENTS/MacOS/Computah"
EOF
chmod +x "$APP/Contents/MacOS/launch"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Computah</string>
<key>CFBundleDisplayName</key><string>Computah</string>
<key>CFBundleIdentifier</key><string>dev.raygen.computah.local</string>
<key>CFBundleExecutable</key><string>launch</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.2.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
EOF
printf 'Built %s\n' "$APP"
