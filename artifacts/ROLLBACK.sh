#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
git checkout '5709b509ecaee5c4e4ac01f2047adda7dbeb1106' -- .env.example README.md server.js server.test.js streaming.test.js
printf '%s\n' 'ROLLBACK_RESULT=restored original tracked files'
