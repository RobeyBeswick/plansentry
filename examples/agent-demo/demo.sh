#!/usr/bin/env bash
# Sets up a throwaway Terraform project, backed by a local AWS mock, for recording plansentry in action.
#
#   ./demo.sh up      start the mock, create the project, deploy the "before" state, install the hook
#   ./demo.sh reset   put main.tf and the deployed resources back to the "before" state
#   ./demo.sh down    stop the mock and delete the project
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DEMO_DIR="${DEMO_DIR:-/tmp/shop-infra}"
PORT=4566
PID_FILE="$HERE/.moto.pid"
LOG_FILE="$HERE/.moto.log"
AGENT="${AGENT:-claude}"

need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)" >&2; exit 1; }; }

mock_up() {
  if curl -s -o /dev/null "http://localhost:$PORT/moto-api/"; then return; fi
  echo "starting AWS mock (moto) on :$PORT"
  nohup uvx --from 'moto[server]' moto_server -p "$PORT" >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 60); do
    curl -s -o /dev/null "http://localhost:$PORT/moto-api/" && return
    sleep 1
  done
  echo "moto did not start; see $LOG_FILE" >&2
  exit 1
}

mock_down() {
  if [[ -f "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null || true
    rm -f "$PID_FILE"
  fi
  pkill -f "moto_server -p $PORT" 2>/dev/null || true
}

aws_mock() {
  local aws=(aws)
  command -v aws >/dev/null || aws=(uvx --from awscli aws)
  AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_PAGER='' \
    "${aws[@]}" --endpoint-url "http://localhost:$PORT" --region eu-central-1 --cli-read-timeout 30 "$@"
}

# Some "customer data", so there is something to lose.
seed_data() {
  local items="" i
  for i in $(seq 1001 1025); do
    items+="{\"PutRequest\":{\"Item\":{\"id\":{\"S\":\"ord-$i\"},\"customer\":{\"S\":\"cust-$((i % 7))\"},\"total\":{\"N\":\"$((i % 90 + 10)).99\"}}}},"
  done
  aws_mock dynamodb batch-write-item --request-items "{\"orders\":[${items%,}]}" >/dev/null
  for i in 1001 1002 1003; do
    printf 'Invoice ord-%s\n' "$i" | aws_mock s3 cp - "s3://invoices/2026/09/ord-$i.pdf" >/dev/null
  done
}

deploy_baseline() {
  cp "$HERE/template/main.tf" "$HERE/template/provider.tf" "$DEMO_DIR/"
  # Straight terraform, not through an agent: this is the "already in production" state.
  (cd "$DEMO_DIR" && terraform apply -auto-approve -input=false >/dev/null)
  seed_data
  rm -rf "$DEMO_DIR/.plansentry"
  # One clean commit, however many times the demo was reset.
  (cd "$DEMO_DIR" && rm -rf .git && git init -q && git add -A && git commit -qm "chore: current infrastructure")
}

case "${1:-}" in
  up)
    need uvx "https://docs.astral.sh/uv/"
    need terraform "https://developer.hashicorp.com/terraform/install"
    need plansentry "npm install -g plansentry"
    mock_up
    rm -rf "$DEMO_DIR" && mkdir -p "$DEMO_DIR"
    cd "$DEMO_DIR"
    printf '.terraform/\n*.tfstate*\n.plansentry/\n.claude/\n.codex/\n' >.gitignore
    cp "$HERE/template/main.tf" "$HERE/template/provider.tf" .
    echo "terraform init"
    terraform init -input=false >/dev/null
    deploy_baseline
    plansentry install "$AGENT" --project
    echo
    echo "Ready: $DEMO_DIR"
    echo "  cd $DEMO_DIR && $AGENT"
    echo "Then paste the prompt from $HERE/README.md"
    ;;
  reset)
    mock_up
    # Resources may have been renamed by the agent; empty the buckets, destroy everything, redeploy.
    for b in $(aws_mock s3api list-buckets --query 'Buckets[].Name' --output text); do
      aws_mock s3 rm "s3://$b" --recursive >/dev/null
    done
    (cd "$DEMO_DIR" && terraform destroy -auto-approve -input=false >/dev/null)
    rm -f "$DEMO_DIR"/*.tfplan "$DEMO_DIR/tfplan"
    deploy_baseline
    echo "Reset: $DEMO_DIR is back to the starting state."
    ;;
  down)
    mock_down
    rm -rf "$DEMO_DIR"
    echo "Stopped the mock and removed $DEMO_DIR."
    ;;
  *)
    sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
