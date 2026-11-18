#!/usr/bin/env bash
# Provision only a disposable GitHub-hosted runner. No production credentials.
set -euo pipefail
if [[ ${GITHUB_ACTIONS:-} != true || ${RUNNER_OS:-} != Linux || -z ${RUNNER_TEMP:-} ]]; then
  echo 'Run this acceptance job on the GitHub-hosted Linux runner.' >&2
  exit 2
fi
umask 077
work=$(mktemp -d "$RUNNER_TEMP/zero-ai-ci.XXXXXXXX")
export BOOK_CONFIG_DIR="$work/config" BOOK_DOMAIN=localhost BOOK_RELEASE=ci
export BOOK_SANDBOX_URL=http://sandbox-gateway:8090 BOOK_GUEST_IMAGE=zero-to-ai-guest:ci
export LEARNER_DOCKER_SOCKET=/run/zero-ai-ci/docker.sock
export LAB_SESSIONS=2 LAB_ACCOUNT_SESSIONS=2 LAB_PARALLEL=2 LAB_TIMEOUT_SECONDS=25
service=zero-ai-ci-learner
compose=(docker compose --project-name zero-ai-ci --profile sandbox)
learner=(docker --host "unix://$LEARNER_DOCKER_SOCKET")

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if (( status != 0 )); then
    "${compose[@]}" ps -a
    "${compose[@]}" logs --tail=35 web identity edge sandbox-gateway
    sudo journalctl -u "$service" -n 25 --no-pager
  fi
  "${compose[@]}" down --volumes --remove-orphans
  sudo systemctl stop "$service"
  rm -f "$BOOK_CONFIG_DIR/"*.key
  exit "$status"
}
trap cleanup EXIT

# Install a fixed gVisor point release, including the matching sidecar binaries.
# Archive/checksum layout: https://gvisor.dev/docs/user_guide/install/#point-release
release=20261109.0
archive=gvisor.tar.zstd
release_url="https://storage.googleapis.com/gvisor/releases/release/$release/x86_64"
(
  cd "$work"
  for file in "$archive" "$archive.sha512"; do
    curl --fail --silent --show-error --location --proto '=https' --retry 3 "$release_url/$file" -o "$file"
  done
  sha512sum --check "$archive.sha512"
  sudo tar --zstd --extract --file "$archive" --directory /usr/local/bin
)
/usr/local/bin/runsc --version

# The application engine builds images. A different engine runs only learners.
# Keep its socket, data, PID and containerd paths separate; guests use network=none.
sudo install -d -m 0755 /run/zero-ai-ci
echo '{}' > "$work/daemon.json"
sudo systemd-run --quiet --unit="$service" --property=Delegate=yes --property=PrivateNetwork=yes "$(command -v dockerd)" \
  --config-file "$work/daemon.json" --host="unix://$LEARNER_DOCKER_SOCKET" --group=docker \
  --exec-root=/run/zero-ai-ci/exec --pidfile=/run/zero-ai-ci/dockerd.pid --data-root="$work/engine" \
  --containerd-namespace=zero-ai-ci --containerd-plugins-namespace=zero-ai-ci-plugins \
  --bridge=none --iptables=false --ip6tables=false --ip-masq=false --ip-forward=false \
  --add-runtime=runsc=/usr/local/bin/runsc
for _ in {1..60}; do
  if "${learner[@]}" info >/dev/null 2>&1; then break; fi
  sleep 1
done
"${learner[@]}" info --format '{{json .Runtimes}}' | jq -e 'has("runsc")' >/dev/null
LEARNER_SOCKET_GID=$(stat -c '%g' "$LEARNER_DOCKER_SOCKET")
export LEARNER_SOCKET_GID
docker build --tag "$BOOK_GUEST_IMAGE" services/sandbox
docker image save "$BOOK_GUEST_IMAGE" | "${learner[@]}" image load

# Diagnose the first guest before any account, learner code or provider secret exists.
# Exercise the gateway's exact OCI restrictions with a small, trusted runtime probe.
DOCKER_HOST="unix://$LEARNER_DOCKER_SOCKET" PYTHONPATH=services/sandbox python3 - <<'PYTHON'
import os, subprocess
from gateway import Config, Session
image = os.environ["BOOK_GUEST_IMAGE"]
session = Session(Config(token="ci-only", image=image), "preflight")
command = session.command()
command[1] = "run"
command[-1:] = ["--entrypoint=python", image, "-I", "-c",
                "import os, socket, threading; print('guest UID', os.getuid(), flush=True); "
                "t=threading.Thread(target=lambda:None); t.start(); t.join(); "
                "s=socket.socket(); s.bind(('127.0.0.1', 8765)); s.close(); "
                "open('/workspace/probe','w').close(); print('guest ready')"]
subprocess.run(command, check=True, timeout=60)
PYTHON

# Directory is runner-private. Compose binds individual files into unprivileged containers.
mkdir "$BOOK_CONFIG_DIR"
: > "$BOOK_CONFIG_DIR/guide.key"
: > "$BOOK_CONFIG_DIR/lab-provider.env"
openssl rand -hex 32 > "$BOOK_CONFIG_DIR/gateway.key"
cp "$BOOK_CONFIG_DIR/gateway.key" "$BOOK_CONFIG_DIR/web-gateway.key"
chmod 0444 "$BOOK_CONFIG_DIR/"*.key
"${compose[@]}" up --build --detach --wait --wait-timeout 180
for _ in {1..30}; do
  if "${compose[@]}" exec -T edge cat /data/caddy/pki/authorities/local/root.crt > "$work/ca.pem" 2>/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --show-error --retry 8 --retry-all-errors --retry-delay 2 \
  --cacert "$work/ca.pem" https://localhost/api/health | jq -e '.persistenceConfigured and .remoteRuntimeConfigured' >/dev/null
export BOOK_PUBLIC_ORIGIN=https://localhost NODE_EXTRA_CA_CERTS="$work/ca.pem"
export BOOK_TEST_READER_A=reader-one BOOK_TEST_READER_B=reader-two
BOOK_TEST_PASSWORD_A=$(openssl rand -hex 24)
BOOK_TEST_PASSWORD_B=$(openssl rand -hex 24)
printf '%s\n' "$BOOK_TEST_PASSWORD_A" | "${compose[@]}" exec -T identity node deploy/identity/provision.mjs "$BOOK_TEST_READER_A"
printf '%s\n' "$BOOK_TEST_PASSWORD_B" | "${compose[@]}" exec -T identity node deploy/identity/provision.mjs "$BOOK_TEST_READER_B"
export BOOK_TEST_PASSWORD_A BOOK_TEST_PASSWORD_B
node deploy/verify-readers.mjs --sandbox
"${compose[@]}" exec -T sandbox-gateway python /opt/gateway/smoke_test.py
remaining=$("${learner[@]}" ps --all --quiet --filter label=ai-book.sandbox.managed=true)
test -z "$remaining"
