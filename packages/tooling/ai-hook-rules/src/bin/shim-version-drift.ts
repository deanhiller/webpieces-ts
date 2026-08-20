// ---------------------------------------------------------------------------
// Shell fragment: L0's VERSION-DRIFT guard (fault D), in pure sh.
//
// Its own module for the same reason shim-audit-log.ts and shim-drift-fix.ts are: shim.ts renders the
// whole shim body and is at its file-size cap. It is spliced back into renderShim() verbatim,
// byte-for-byte, and it imports nothing — this has to run on a tree too broken to load the rule engine.
//
// The rationale for every branch is IN the fragment, as shell comments, and stays there: unlike
// shim-drift-fix.ts's Fix Options, this text is the guard's own reasoning about a tree it cannot
// otherwise explain, and a reader debugging a live block is reading the rendered .sh, not this file.
// ---------------------------------------------------------------------------
export const VERSION_DRIFT_GUARD_SH = `# --- webpieces version-drift guard (pure sh — runs even when the installed guard bin is stale) -----
# The committed shim is version-agnostic, so it keeps working right after a git pull, BEFORE the
# matching pnpm install. That is exactly when node_modules can be STALE: an OLDER @webpieces than
# package.json now pins, whose outdated validator rejects the NEWER webpieces.config.json with baffling
# "unknown rule" errors. Detect that drift HERE (before exec'ing the possibly-stale bin): compare every
# EXACT-pinned @webpieces/* version in the root package.json against the version actually installed in
# node_modules; the first mismatch wins. Range specs (^ ~ workspace:*) are skipped, so they never
# false-positive; best-effort — a version we cannot read is skipped. On drift we fall through to the
# SAME fail-closed path as a missing bin (allow only pnpm install, deny the rest).
#
# pnpm CATALOGS: a dep pinned via "catalog:" / "catalog:<name>" carries NO digit-version in package.json,
# so the old scraper matched nothing and the guard was BLIND to it — DRIFT_PKG stayed empty and the
# stale bin ran (the 2026-07 "0.3.369 vs 0.4.405" incident). Resolve those specs through the top-level
# \`catalogs:\` block of pnpm-lock.yaml (catalog -> pkg -> resolved version) before comparing.
#
# THE SAME PASS ANSWERS FAULT U (2026-08-05). Scraping root package.json is also the only way to learn
# whether @webpieces/ai-hook-rules is DECLARED at all, and that is the difference between "not installed
# yet" (X, cured by pnpm install) and "nothing asks for it" (U, where pnpm install is a guaranteed
# no-op). WP_PIN carries the first EXACT @webpieces pin found, so U's deny can prescribe the version the
# rest of the repo is already on rather than an unpinned add. Both are set BEFORE the range/catalog
# \`continue\`s, so a repo pinning the package by range still counts as having declared it.
DRIFT_PKG=""
DRIFT_DECLARED=""
DRIFT_INSTALLED=""
WP_HOOK_PKG_DECLARED=""
WP_PIN=""
if [ -f "$ROOT/package.json" ]; then
  # Only when a @webpieces dep actually uses a "catalog:" spec do we scan the (possibly huge) lockfile —
  # a cheap grep keeps the common, catalog-free repo from paying that cost on every tool call. One awk
  # pass over pnpm-lock.yaml emits "<catalog> <@webpieces/pkg> <version>" lines for the sh lookup below;
  # \\047 is a single quote (so this awk program carries none and stays safely single-quotable in sh).
  WP_CATALOGS=""
  WP_WS_CATALOGS=""
  # THE PIN LIVES IN pnpm-workspace.yaml, and the LOCK is only the fallback (2026-08-20).
  #
  # L0 used to learn the pin from pnpm-lock.yaml's \`catalogs:\` alone, while L1's WebpiecesVersions.readPin
  # reads pnpm-workspace.yaml. Two notions of "the pin", and the gap is exactly where the cure lands: an
  # agent told to raise this tree's pin edits pnpm-workspace.yaml, re-runs, and L0 still reports the OLD
  # number — because only \`pnpm install\` rewrites the lock — so it concludes the edit did nothing and
  # reaches for something worse. Reading the workspace manifest FIRST makes the edit visible immediately.
  #
  # It resolves the same two YAML shapes readPin does, and that is not optional: a repo pinning the whole
  # @webpieces family in lockstep writes the version ONCE as \`&wp 0.4.669\` and aliases the rest as \`*wp\`,
  # so an anchor-blind read silently nulls the leg on precisely the repos that pin most carefully. Both
  # \`catalog:\` (the default catalog) and \`catalogs:\` (named ones) are walked. A value that is not a plain
  # digit-version (a range) is NOT emitted, so a loose pinner falls through to the lock rather than being
  # compared against an incomparable spec.
  if grep -Eq '"@webpieces/[^"]*"[[:space:]]*:[[:space:]]*"catalog:' "$ROOT/package.json" 2>/dev/null && [ -f "$ROOT/pnpm-workspace.yaml" ]; then
    WP_WS_CATALOGS="$(awk '
      { n=0; while (substr($0,n+1,1)==" ") n++; c=substr($0,n+1) }
      c=="" || substr(c,1,1)=="#" { next }
      {
        ai=index(c,":")
        if (ai>0) {
          av=substr(c,ai+1); sub(/^[ \\t]+/,"",av)
          if (substr(av,1,1)=="&") {
            an=substr(av,2); sub(/[ \\t].*/,"",an)
            sub(/^&[^ \\t]+[ \\t]*/,"",av)
            sub(/[ \\t]+#.*/,"",av); gsub(/["\\047]/,"",av); sub(/[ \\t].*/,"",av)
            if (an!="" && av!="") anch[an]=av
          }
        }
      }
      n==0 { mode=(c ~ /^catalog: *$/)?1:((c ~ /^catalogs: *$/)?2:0); cat=(mode==1)?"default":""; next }
      mode==0 { next }
      mode==2 && c ~ /^[^:]+: *$/ { cat=c; sub(/: *$/,"",cat); gsub(/["\\047 ]/,"",cat); next }
      {
        ki=index(c,":")
        if (ki<=0) next
        k=substr(c,1,ki-1); gsub(/["\\047 ]/,"",k)
        if (substr(k,1,11)!="@webpieces/") next
        v=substr(c,ki+1); sub(/^[ \\t]+/,"",v); sub(/^&[^ \\t]+[ \\t]*/,"",v)
        sub(/[ \\t]+#.*/,"",v); gsub(/["\\047]/,"",v); sub(/[ \\t].*/,"",v)
        if (v=="") next
        nn++; key[nn]=cat " " k; ali[nn]=(substr(v,1,1)=="*")?substr(v,2):""; val[nn]=v
      }
      END { for (i=1;i<=nn;i++) { vv=(ali[i]=="")?val[i]:anch[ali[i]]; if (vv ~ /^[0-9]/) print key[i] " " vv } }
    ' "$ROOT/pnpm-workspace.yaml" 2>/dev/null)"
  fi
  if grep -Eq '"@webpieces/[^"]*"[[:space:]]*:[[:space:]]*"catalog:' "$ROOT/package.json" 2>/dev/null && [ -f "$ROOT/pnpm-lock.yaml" ]; then
    WP_CATALOGS="$(awk '
      { n=0; while (substr($0,n+1,1)==" ") n++; c=substr($0,n+1) }
      c=="" { next }
      n==0 { incat=(c ~ /^catalogs: *$/)?1:0; cat=""; pkg=""; next }
      incat==0 { next }
      n==2 { cat=c; sub(/:.*/,"",cat); pkg=""; next }
      n==4 { pkg=c; sub(/: *$/,"",pkg); gsub(/["\\047]/,"",pkg); next }
      n==6 && substr(pkg,1,11)=="@webpieces/" && c ~ /^version:/ {
        v=c; sub(/^version: */,"",v); gsub(/["\\047 ]/,"",v);
        if (cat!="" && v!="") print cat " " pkg " " v
      }
    ' "$ROOT/pnpm-lock.yaml" 2>/dev/null)"
  fi
  while IFS=' ' read -r WP_NAME WP_DECL; do
    [ -n "$WP_NAME" ] || continue
    # Fault U's input: the package is DECLARED (in any spec shape, in any dependency block of the root
    # manifest). Recorded before every \`continue\` below, so a range or catalog spec still counts.
    [ "$WP_NAME" = "ai-hook-rules" ] && WP_HOOK_PKG_DECLARED=1
    # Resolve the declared spec to an EXACT version, or skip it: ranges (^ ~ workspace:*) never drift,
    # and a catalog spec we cannot resolve is best-effort skipped rather than guessed.
    case "$WP_DECL" in
      catalog:*)
        WP_CAT="\${WP_DECL#catalog:}"; [ -n "$WP_CAT" ] || WP_CAT="default"
        WP_DECL="$(printf '%s\\n' "$WP_WS_CATALOGS" | awk -v c="$WP_CAT" -v p="@webpieces/$WP_NAME" '$1==c && $2==p {print $3; exit}')"
        [ -n "$WP_DECL" ] || WP_DECL="$(printf '%s\\n' "$WP_CATALOGS" | awk -v c="$WP_CAT" -v p="@webpieces/$WP_NAME" '$1==c && $2==p {print $3; exit}')"
        [ -n "$WP_DECL" ] || continue ;;
      [0-9]*) : ;;
      *) continue ;;
    esac
    # The release the rest of this repo is on — what fault U's cure should pin to.
    [ -n "$WP_PIN" ] || WP_PIN="$WP_DECL"
    WP_MANIFEST="$BIN_ROOT/node_modules/@webpieces/$WP_NAME/package.json"
    [ -f "$WP_MANIFEST" ] || continue
    WP_INST="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$WP_MANIFEST" | head -n1)"
    [ -n "$WP_INST" ] || continue
    if [ "$WP_DECL" != "$WP_INST" ]; then
      DRIFT_PKG="@webpieces/$WP_NAME"
      DRIFT_DECLARED="$WP_DECL"
      DRIFT_INSTALLED="$WP_INST"
      break
    fi
  done <<WPEOF
$(sed -n 's/.*"@webpieces\\/\\([A-Za-z0-9._-]*\\)"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1 \\2/p' "$ROOT/package.json")
WPEOF
fi
# A BORROWED BIN IS NOT SINGLE-TREE DRIFT, SO L0 MUST NOT ANSWER IT (2026-08-20).
#
# RESOLVE_BIN_SH walks UP for the bin, so in a linked worktree with no node_modules of its own BIN_ROOT
# is the MAIN tree. The scan above then compares $ROOT's DECLARED pin against $BIN_ROOT's INSTALLED
# version — a CROSS-TREE comparison it was reporting as fault D, single-tree drift. Everything
# downstream of that mislabel was wrong:
#   • the cure. 'pnpm install' cannot "align node_modules" in a tree that has none; it MANUFACTURES one,
#     at this tree's stale pin. That is precisely the state L1 row 8 (trinary-version-skew) blocks, so
#     the L0 cure created the next block. One measured agent was walked from a pin disagreement, through
#     'pnpm install' offered as "(preferred) ... usually right", to a DOWNGRADED engine and a total block.
#   • the analysis. Row 8 already reads all FOUR versions (both trees' pins and both installs), already
#     knows which direction to move, already detects a deliberate pin bump, and already carries the
#     escalate-and-STOP protocol. It could never run: ai-hook.sh hard-exits on any sh-side fault, so D
#     PREEMPTED the guard that had the right answer.
# So: when the bin came from another tree, raise NO fault here and let the binary run. D stays exactly as
# it was when ROOT == BIN_ROOT — that IS single-tree drift, and row 8 cannot see it (VersionSyncGuard
# only applies to a linked worktree compared against a DIFFERENT main tree). Coverage does not gap: if
# the two pins agree but the two installs differ, row 8's quartet still has two distinct members and it
# still fires. X / U / K are untouched — a MISSING or CRASHED bin is about the bin, not about a version.
if [ "$BIN_ROOT" != "$ROOT" ]; then
  DRIFT_PKG=""
  DRIFT_DECLARED=""
  DRIFT_INSTALLED=""
fi`;
