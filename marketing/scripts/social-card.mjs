import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const dataUrl = async (path, mime) => `data:${mime};base64,${(await readFile(resolve(root, path))).toString('base64')}`;
const [font, caveat, screenshot] = await Promise.all([
  dataUrl('app/fonts/geist-latin.woff2', 'font/woff2'),
  dataUrl('app/fonts/caveat-700.woff2', 'font/woff2'),
  dataUrl('public/images/audora-listen.webp', 'image/webp'),
]);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
    @font-face{font-family:Geist;src:url('${font}')}@font-face{font-family:Caveat;src:url('${caveat}');font-weight:700}
    *{box-sizing:border-box}body{margin:0;background:#111110;color:#f3f0e9;font-family:Geist,Arial,sans-serif;width:1200px;height:630px;overflow:hidden}
    .brand{position:absolute;left:62px;top:34px;font:700 55px Caveat;color:#e4c7a5}.version{position:absolute;right:62px;top:58px;font-size:12px;letter-spacing:2px;color:#b5a995}
    .rule{position:absolute;top:112px;left:62px;right:62px;height:1px;background:#ffffff20}h1{position:absolute;left:62px;top:171px;margin:0;font-size:68px;letter-spacing:-3.5px;line-height:1.1;font-weight:500}h1 span{color:#c4b9a8}
    p{position:absolute;left:62px;top:341px;color:#aaa79f;font-size:18px;line-height:1.75}.button{position:absolute;left:62px;top:450px;border-radius:50px;padding:16px 27px;background:#e5b882;color:#1c1711;font-size:16px;font-weight:600}
    .screen{position:absolute;left:574px;top:174px;width:755px;background:#21201d;padding:7px;border:1px solid #ac956f55;border-radius:13px;transform:perspective(1600px) rotateY(-10deg) rotateZ(-2deg);transform-origin:left center;box-shadow:0 25px 70px #0008}.screen img{width:100%;display:block;border-radius:7px}
    .footer{position:absolute;left:62px;bottom:37px;color:#9f978b;font-size:12px;letter-spacing:1.4px}.caption{position:absolute;right:52px;bottom:36px;color:#928b7e;font-size:10px}
  </style></head><body><div class="brand">Audora.</div><div class="version">WINDOWS + LINUX</div><div class="rule"></div><h1>Your music.<br><span>All the detail.</span></h1><p>Lossless FLAC.<br>Your own home for listening.</p><div class="button">Download Audora ↗</div><div class="screen"><img src="${screenshot}" alt="Audora desktop interface"></div><div class="footer">LOSSLESS AUDIO. LOCAL LISTENING.</div><div class="caption">Actual interface · Demonstration library</div></body></html>`);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())); });
  await page.screenshot({ path: resolve(root, 'public/social-preview.png') });
  console.log('Social preview created at 1200 × 630.');
} finally { await browser.close(); }
