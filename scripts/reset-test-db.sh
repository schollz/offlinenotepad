#!/usr/bin/env bash

set -euo pipefail

readonly test_database='offlinenotepad_dev'
readonly script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly project_directory="$(cd -- "${script_directory}/.." && pwd)"
readonly dotenv_file="${project_directory}/.env"

load_database_url() {
  local line value first last
  [[ -f "$dotenv_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=(.*)$ ]]; then
      value="${BASH_REMATCH[2]}"
      value="${value#"${value%%[![:space:]]*}"}"
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
      first="${value:0:1}"
      last="${value: -1}"
      if [[ ${#value} -ge 2 ]] && { [[ "$first" == '"' && "$last" == '"' ]] || [[ "$first" == "'" && "$last" == "'" ]]; }; then
        value="${value:1:${#value}-2}"
      fi
      export DATABASE_URL="$value"
      return 0
    fi
  done < "$dotenv_file"
}

if [[ "${DATABASE_URL+x}" != x ]]; then
  load_database_url
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo 'DATABASE_URL must be exported or set in .env and point to the offlinenotepad_dev PostgreSQL database.' >&2
  exit 1
fi

case "$DATABASE_URL" in
  postgres://* | postgresql://*) ;;
  *)
    echo 'DATABASE_URL must be a postgres:// or postgresql:// URL.' >&2
    exit 1
    ;;
esac

connection_without_query="${DATABASE_URL%%\?*}"
connection_query=''
if [[ "$DATABASE_URL" == *\?* ]]; then
  connection_query="?${DATABASE_URL#*\?}"
fi

configured_database="${connection_without_query##*/}"
if [[ "$configured_database" != "$test_database" ]]; then
  echo "Refusing to reset PostgreSQL: DATABASE_URL must name ${test_database}." >&2
  exit 1
fi
if [[ "$connection_query" =~ (^|[?&])dbname= ]]; then
  echo 'Refusing to reset PostgreSQL: DATABASE_URL must not override dbname in its query.' >&2
  exit 1
fi
if ! command -v psql >/dev/null 2>&1; then
  echo 'psql is required to reset the PostgreSQL test database.' >&2
  exit 1
fi

maintenance_url="${connection_without_query%/*}/postgres${connection_query}"

psql --no-psqlrc --dbname="$maintenance_url" --set=ON_ERROR_STOP=1 \
  --command='DROP DATABASE IF EXISTS "offlinenotepad_dev" WITH (FORCE);'
psql --no-psqlrc --dbname="$maintenance_url" --set=ON_ERROR_STOP=1 \
  --command='CREATE DATABASE "offlinenotepad_dev";'

echo 'Reset PostgreSQL test database offlinenotepad_dev.'
