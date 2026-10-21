/**
 * Zmenší velký obrázek před nahráním: přepočítá ho na nejvýš `maxSide` pixelů delší strany a zakóduje (WebP nebo PNG pro průhlednost),
 * dokud se nevejde do `maxBytes`. Vrací původní soubor, když už se vejde. Funguje v prohlížeči (canvas).
 */
export async function shrinkImage(file: File, opts: { maxBytes: number; maxSide: number; keepAlpha: boolean }): Promise<{ data: ArrayBuffer; shrunk: boolean }> {
  if (file.size <= opts.maxBytes) {
    const bmp = await createImageBitmap(file).catch(() => null);
    const within = !bmp || Math.max(bmp.width, bmp.height) <= opts.maxSide;
    bmp?.close();
    if (within) return { data: await file.arrayBuffer(), shrunk: false };
  }
  const bmp = await createImageBitmap(file);
  let scale = Math.min(1, opts.maxSide / Math.max(bmp.width, bmp.height));
  for (let attempt = 0; attempt < 8; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    // Bez průhlednosti stačí ztrátový WebP (menší soubor); s průhledností zůstává PNG.
    const blob = await new Promise<Blob | null>((resolve) => (opts.keepAlpha ? canvas.toBlob(resolve, 'image/png') : canvas.toBlob(resolve, 'image/webp', 0.85)));
    if (blob && blob.size <= opts.maxBytes) {
      bmp.close();
      return { data: await blob.arrayBuffer(), shrunk: true };
    }
    scale *= 0.75;
  }
  bmp.close();
  throw new Error('IMAGE_TOO_LARGE');
}
