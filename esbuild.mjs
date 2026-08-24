import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * watch 모드에서 빌드 시작/완료 마커를 출력한다. VS Code의 백그라운드 problem matcher가
 * 이 마커(beginsPattern/endsPattern)로 "번들 준비 완료"를 감지해 F5 실행을 시작한다.
 */
const watchStatusPlugin = {
  name: 'watch-status',
  setup(build) {
    build.onStart(() => {
      if (watch) {
        console.log('[watch] build started');
      }
    });
    build.onEnd((result) => {
      for (const { text, location } of result.errors) {
        console.error(`✘ [ERROR] ${text}`);
        if (location) {
          console.error(`    ${location.file}:${location.line}:${location.column}:`);
        }
      }
      if (watch) {
        console.log('[watch] build finished');
      }
    });
  },
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/extension.js',
    // vscode는 런타임 제공, *.node(ssh2의 선택적 네이티브 crypto)는 번들에서 제외 →
    // 네이티브 바이너리를 패키지에 넣지 않고 순수 JS로 폴백해 크로스플랫폼 배포를 보장한다.
    external: ['vscode', '*.node'],
    sourcemap: !production,
    minify: production,
    logLevel: 'silent',
    plugins: [watchStatusPlugin],
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
