# The one carve-out to "no anonymous object literals"

Moved verbatim out of `CLAUDE.md` section "3. No Anonymous Object Literals". Read this when you are
about to write an object literal as a DECORATOR argument, or when you are reviewing one.

#### The one carve-out: DECORATOR arguments that encode a compiler-enforced choice

A decorator argument may be an object literal typed by a **discriminated union**, when the union is what
makes an invalid combination fail to compile:

```typescript
@AuthJwt({ roles: ['admin'] })         // ✅ role-gated
@AuthJwt({ allRolesAllowed: true })    // ✅ every authenticated user, said out loud
@AuthJwt({})                           // ❌ compile error — pick a branch
@AuthJwt({ roles: [] })                // ❌ compile error — needs at least one role
```

This is not a loophole for skipping a class, and it does not apply to configs, definitions, or DTOs —
those still take a class. It exists because **a class cannot express this guarantee.** A class is one
shape: to cover both branches you would need either two classes (which is the "two spellings" shim the
compatibility policy rejects) or one class plus a runtime `throw` (which is shim shape #4 — a throw
standing in for a type that cannot express the bad state). The union is the only form where the invariant
is enforced at the moment the line is written, and that moment is the only one that changes what an agent
writes.

The test for whether the carve-out applies: **delete the union and ask what enforces the rule instead.**
If the answer is "a runtime check" or "a code review", use the union. If the answer is "nothing was being
enforced, it is just a bag of fields", use a class. `@Endpoint(..., { calledBy })` and
`JwtRequirement`'s app-defined fields are the existing precedent.
