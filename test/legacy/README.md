# Legacy admin tests

These tests target the deleted `src/admin.ts` and `web/` files. They were moved
here, with a `.disabled` suffix, so they are neither typechecked nor executed
while the API-first gateway replaces the old admin. Re-enable them only after
the admin facade and its static UI are deliberately restored.
