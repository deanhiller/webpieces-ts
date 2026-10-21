#!/usr/bin/env bash
# Keeps the CI Nx cache usable and bounded (issue #1363). Two subcommands:
#
#   adopt-db  run right AFTER actions/cache restores .nx/cache + .nx/workspace-data/*.db
#   prune     run right BEFORE actions/cache/save, after every nx command of the job
#
# WHY this exists: nx 22's local cache is TWO things, and caching only one of them is useless.
#   - .nx/cache/<hash>/ (+ .nx/cache/terminalOutputs/<hash>) holds the task outputs.
#   - .nx/workspace-data/<machine-id>.db (sqlite, table cache_outputs) is the INDEX. NxCache.get()
#     is `UPDATE cache_outputs SET accessed_at = now WHERE hash = ? RETURNING ...`: a hash with no row
#     is a MISS even when its directory is sitting right there. maxCacheSize LRU eviction (on every
#     put) and the 7-days-unused sweep (removeOldCacheRecords) both select their victims from that
#     table too, so a directory the db does not know is never served AND never evicted.
#   Restoring .nx/cache without the db therefore buys nothing but the download, and the next save
#   carries every unknown directory forward forever. So the db is cached with the outputs.
#
# adopt-db: the db file is named after the machine id (machine-uid crate: /var/lib/dbus/machine-id,
#   else /etc/machine-id, trimmed), and each GitHub runner may have its own. Renaming the restored db
#   to THIS runner's id makes nx open it instead of creating an empty one beside it.
# prune: deletes every output directory and terminal output the db does not list, so the saved entry
#   is exactly what nx is tracking — bounded by maxCacheSize and aging out after 7 days unused,
#   like Gradle's build-cache cleanup — instead of a union that only grows.
set -euo pipefail

CACHE_DIR="${NX_CACHE_DIRECTORY:-.nx/cache}"
DATA_DIR="${NX_WORKSPACE_DATA_DIRECTORY:-.nx/workspace-data}"

machine_id() {
    local id=""
    case "$(uname -s)" in
        Linux)
            if [ -r /var/lib/dbus/machine-id ]; then
                id="$(tr -d '[:space:]' < /var/lib/dbus/machine-id)"
            elif [ -r /etc/machine-id ]; then
                id="$(tr -d '[:space:]' < /etc/machine-id)"
            fi
            ;;
        Darwin)
            id="$(ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/{print $4}')"
            ;;
    esac
    if [ -z "$id" ]; then
        echo "ci-nx-cache: cannot determine the machine id nx names its db after" >&2
        exit 1
    fi
    printf '%s' "$id"
}

adopt_db() {
    mkdir -p "$CACHE_DIR" "$DATA_DIR"
    local target="$DATA_DIR/$(machine_id).db"
    local dbs=()
    local f
    while IFS= read -r f; do dbs+=("$f"); done < <(ls -t "$DATA_DIR"/*.db 2>/dev/null || true)
    if [ ${#dbs[@]} -eq 0 ]; then
        echo "ci-nx-cache: no nx db restored (cold cache); nx starts a fresh index"
        return 0
    fi
    if [ -f "$target" ]; then
        echo "ci-nx-cache: restored nx db already matches this machine: $target"
        return 0
    fi
    # Newest first: if more than one came back, the newest is the one the last run used.
    mv "${dbs[0]}" "$target"
    for f in "${dbs[@]:1}"; do rm -f "$f"; done
    echo "ci-nx-cache: adopted restored nx db ${dbs[0]} as $target"
}

prune() {
    local db="$DATA_DIR/$(machine_id).db"
    if [ ! -d "$CACHE_DIR" ]; then
        echo "ci-nx-cache: no $CACHE_DIR, nothing to prune"
        return 0
    fi
    if [ ! -f "$db" ]; then
        echo "::warning::ci-nx-cache: nx db $db not found, so no cache entry is tracked; emptying $CACHE_DIR"
    fi
    echo "ci-nx-cache: before prune $(du -sh "$CACHE_DIR" | cut -f1) in $CACHE_DIR"
    node --no-warnings - "$CACHE_DIR" "$db" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const [cacheDir, dbPath] = process.argv.slice(2);
const known = new Set();
if (fs.existsSync(dbPath)) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    // nx runs the db in WAL mode. Fold the WAL into the .db file so the one file the cache saves
    // holds every row this run wrote.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    for (const row of db.prepare('SELECT hash FROM cache_outputs').all()) known.add(String(row.hash));
    db.close();
}
const isHash = (name) => /^\d+$/.test(name);
let removedDirs = 0;
let removedOutputs = 0;
for (const name of fs.readdirSync(cacheDir)) {
    if (isHash(name) && !known.has(name)) {
        fs.rmSync(path.join(cacheDir, name), { recursive: true, force: true });
        removedDirs++;
    }
}
const terminalOutputs = path.join(cacheDir, 'terminalOutputs');
if (fs.existsSync(terminalOutputs)) {
    for (const name of fs.readdirSync(terminalOutputs)) {
        if (!known.has(name)) {
            fs.rmSync(path.join(terminalOutputs, name), { force: true });
            removedOutputs++;
        }
    }
}
console.log(`ci-nx-cache: db tracks ${known.size} entries; removed ${removedDirs} untracked output dirs and ${removedOutputs} untracked terminal outputs`);
NODE
    # Any other db is a guess that did not match this machine; saving it would only carry it forward.
    local f
    for f in "$DATA_DIR"/*.db; do
        [ -e "$f" ] || continue
        if [ "$f" != "$db" ]; then
            rm -f "$f" "$f-wal" "$f-shm"
            echo "ci-nx-cache: removed stale nx db $f"
        fi
    done
    echo "ci-nx-cache: after prune $(du -sh "$CACHE_DIR" | cut -f1) in $CACHE_DIR"
}

case "${1:-}" in
    adopt-db) adopt_db ;;
    prune) prune ;;
    *)
        echo "usage: $0 adopt-db|prune" >&2
        exit 2
        ;;
esac
