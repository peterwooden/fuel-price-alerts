// Bundle each Lambda handler into dist/<name>/index.js; Terraform zips those folders.
import { build } from 'esbuild';

for (const name of ['ingest', 'subscriptions']) {
    await build({
        entryPoints: [`src/${name}.ts`],
        outfile: `dist/${name}/index.js`,
        bundle: true,
        minify: true,
        sourcemap: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        logLevel: 'info',
    });
}
