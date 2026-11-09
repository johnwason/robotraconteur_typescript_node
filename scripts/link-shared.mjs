// Link the sibling robotraconteur_typescript checkout, until the shared package is on npm.
import { existsSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shared = resolve(process.env.RR_SHARED ?? join(root, "../robotraconteur_typescript"));
const link = join(root, "node_modules/robotraconteur");

if (!existsSync(join(shared, "dist/internal.js")))
{
    console.error(`${shared} has no built copy of the shared package. Run "npm run build" there first.`);
    process.exit(1);
}

let linked = false;
try
{
    linked = lstatSync(link) !== undefined;
}
catch
{
    // Not linked yet
}
if (!linked)
{
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), shared), link, "junction");
}
