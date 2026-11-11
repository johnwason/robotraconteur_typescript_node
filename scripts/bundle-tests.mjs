// Bundle the tests against the source of the shared package, so that the shared client tests and
// this package use a single copy of the library.
import { build } from "esbuild";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shared = resolve(process.env.RR_SHARED ?? join(root, "../robotraconteur_typescript"));

const entry_points = ["unit", "integration", "extra"].flatMap((d) =>
    readdirSync(join(root, "test", d)).filter((f) => f.endsWith(".test.ts")).map((f) => join(root, "test", d, f)));

await build({
    entryPoints: entry_points,
    outdir: join(root, "dist-test"),
    outbase: join(root, "test"),
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: "inline",
    logLevel: "warning",
    // Loaded from node_modules at run time, along with its optional native modules
    external: ["ws"],
    // The shared tests read Core's test vector blob relative to their own compiled files, which
    // are not where the bundles are. Give them the blob from the shared repository before any
    // module runs, through the hook that the browser test page also uses.
    banner: {
        js: `globalThis.rr_test_vectors_base64 ??= (await import("node:fs")).readFileSync(${JSON.stringify(join(shared, "test/data/test_vectors.bin"))}).toString("base64");`
    },
    plugins: [{
        name: "shared-source",
        setup(b)
        {
            b.onResolve({ filter: /^robotraconteur(\/internal)?$/ }, (a) => ({
                path: join(shared, "src", a.path.endsWith("/internal") ? "internal.ts" : "index.ts")
            }));
            b.onResolve({ filter: /^@shared\// }, (a) => ({ path: join(shared, a.path.slice("@shared/".length).replace(/\.js$/, ".ts")) }));
        }
    }]
});
