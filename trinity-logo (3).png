// Run once: node generate-icons.mjs
// Generates simple SVG-based placeholder icons.
// Replace public/icon-192.png and public/icon-512.png with real branded icons before launch.

import { createCanvas } from 'canvas';
import { writeFileSync } from 'fs';

function makeIcon(size, outPath) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Dark background
  ctx.fillStyle = '#0a0c10';
  ctx.fillRect(0, 0, size, size);

  // Storm circle
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.38, 0, Math.PI * 2);
  ctx.strokeStyle = '#1e90ff';
  ctx.lineWidth = size * 0.04;
  ctx.stroke();

  // Lightning bolt
  ctx.fillStyle = '#fbbf24';
  const s = size * 0.18;
  const cx = size / 2;
  const cy = size / 2;
  ctx.beginPath();
  ctx.moveTo(cx + s * 0.3, cy - s);
  ctx.lineTo(cx - s * 0.1, cy + s * 0.1);
  ctx.lineTo(cx + s * 0.2, cy + s * 0.1);
  ctx.lineTo(cx - s * 0.3, cy + s);
  ctx.lineTo(cx + s * 0.1, cy - s * 0.1);
  ctx.lineTo(cx - s * 0.2, cy - s * 0.1);
  ctx.closePath();
  ctx.fill();

  writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log(`Created ${outPath}`);
}

makeIcon(192, 'public/icon-192.png');
makeIcon(512, 'public/icon-512.png');
makeIcon(180, 'public/apple-touch-icon.png');
