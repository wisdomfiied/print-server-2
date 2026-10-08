// Renders a Shopify order into an Uber Eats-style PNG ticket for Star CloudPRNT printers.
// 80mm paper = 576 dots wide (default). 58mm = 384.
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');
const QRCode = require('qrcode');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = parseInt(process.env.PAPER_WIDTH || '576', 10);
const PAD = 16;
// Bundled font: hosting servers have no system fonts, so text would render blank without this.
GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'LiberationSans-Regular.ttf'), 'ReceiptSans');
GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', 'LiberationSans-Bold.ttf'), 'ReceiptSans');
const FONT = 'ReceiptSans';
const TZ = process.env.TZ_NAME || 'America/New_York';

// Promo config: promo.json (edit without code changes) overrides env vars.
function loadPromo() {
  let p = {};
  try { p = JSON.parse(fs.readFileSync(path.join(__dirname, 'promo.json'), 'utf8')); } catch {}
  return {
    title: p.title ?? process.env.PROMO_TITLE ?? '',
    text: p.text ?? process.env.PROMO_TEXT ?? '',
    code: p.code ?? process.env.PROMO_CODE ?? '',
    qrUrl: p.qrUrl ?? process.env.PROMO_QR_URL ?? '',
    qrCaption: p.qrCaption ?? process.env.PROMO_QR_CAPTION ?? '',
  };
}

// Thermal printers can't print emoji; strip them so they don't show as empty boxes.
const clean = t => String(t ?? '')
  .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]/gu, '')
  .replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\(\)/g, '')
  .replace(/[ \t]{2,}/g, ' ').trim();

// Pull "Pickup time: 9:00 PM" (or Delivery time / Pickup date ...) out of the order note.
// Returns { time, rest } where rest is the note with that line removed.
function timeFromNote(note) {
  const re = /^\s*(pick[\s-]?up|delivery|ready)\s*(date\s*(?:&|and)?\s*)?(time)?\s*[:\-]\s*(.+)$/im;
  const m = String(note || '').match(re);
  if (!m) return { time: null, rest: note || '' };
  return { time: m[4].trim(), rest: String(note).replace(m[0], '').replace(/\n{2,}/g, '\n').trim() };
}

const money = v => '$' + (parseFloat(v || 0)).toFixed(2);

function attr(order, ...names) {
  for (const n of names) {
    const hit = (order.note_attributes || []).find(a => a.name && a.name.toLowerCase() === n.toLowerCase());
    if (hit && hit.value) return String(hit.value);
  }
  return null;
}

function fulfillmentType(order) {
  const explicit = attr(order, 'Delivery Method', 'Fulfillment', 'Order Type', 'Checkout-Method');
  if (explicit) return explicit.toUpperCase();
  const line = (order.shipping_lines || [])[0];
  const t = ((line && (line.title || line.code)) || '').toLowerCase();
  if (t.includes('pick')) return 'PICKUP';
  if (t.includes('deliver') || order.shipping_address) return 'DELIVERY';
  return 'PICKUP';
}

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) { out.push(cur); cur = w; } else cur = test;
    }
    out.push(cur);
  }
  return out;
}

// ---- 1-bit PNG encoder.
// The printer decodes PNGs in very little memory: a full-color 576x2000 image needs ~4.5 MB and fails
// with "511 Media Decoding Error". 1-bit black/white needs ~140 KB and matches what thermal paper can print.
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodeMonoPng(rgba, w, h, threshold = 160) {
  const rowBytes = Math.ceil(w / 8);
  const raw = Buffer.alloc((rowBytes + 1) * h, 0);
  for (let y = 0; y < h; y++) {
    const ro = y * (rowBytes + 1); raw[ro] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255;
      const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a);
      if (lum >= threshold) raw[ro + 1 + (x >> 3)] |= 0x80 >> (x & 7); // 1 = white, 0 = black
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 1; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 1-bit grayscale, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- StarPRNT native raster: the printer prints these bits directly, no image decoding.
// ESC @ (init) | ESC GS S 1 xL xH yL yH 0 <bits> per band (1 = black dot) | ESC d 3 (feed + partial cut)
function encodeStarPrnt(rgba, w, h, threshold = 160) {
  const rowBytes = Math.ceil(w / 8);
  const parts = [Buffer.from([0x1b, 0x40])];
  const BAND = 128;
  for (let y0 = 0; y0 < h; y0 += BAND) {
    const bh = Math.min(BAND, h - y0);
    const hdr = Buffer.from([0x1b, 0x1d, 0x53, 0x01, rowBytes & 0xff, rowBytes >> 8, bh & 0xff, bh >> 8, 0x00]);
    const bits = Buffer.alloc(rowBytes * bh, 0);
    for (let yy = 0; yy < bh; yy++) {
      for (let x = 0; x < w; x++) {
        const i = ((y0 + yy) * w + x) * 4;
        const a = rgba[i + 3] / 255;
        const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * a + 255 * (1 - a);
        if (lum < threshold) bits[yy * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
    parts.push(hdr, bits);
  }
  parts.push(Buffer.from([0x1b, 0x64, 0x03]));
  return Buffer.concat(parts);
}

// Thermal printers are 1-bit: convert logo to pure black/white so it prints crisp, not muddy.
function toMono(ctx, x, y, w, h, threshold = 150) {
  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    const lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a);
    const v = lum < threshold ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  ctx.putImageData(img, x, y);
}

async function renderReceipt(order, opts = {}) {
  const storeName = opts.storeName || process.env.STORE_NAME || 'Your Restaurant';
  const storeLine = opts.storeLine ?? process.env.STORE_LINE ?? '';
  const logoPath = opts.logoPath ? path.resolve(__dirname, opts.logoPath) : null;
  const promo = opts.promo || loadPromo();
  const hasPromo = promo && (promo.title || promo.text || promo.code || promo.qrUrl);

  const H = 8000;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  let y = PAD;

  const font = (size, bold) => { ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`; };
  const text = (t, size, { bold = false, align = 'left', x = PAD, color = '#000' } = {}) => {
    font(size, bold); ctx.fillStyle = color; ctx.textAlign = align;
    ctx.fillText(t, align === 'center' ? W / 2 : align === 'right' ? W - PAD : x, y);
    ctx.textAlign = 'left';
  };
  const rule = (thick = 2, dashed = false) => {
    ctx.fillStyle = '#000';
    if (!dashed) ctx.fillRect(PAD, y, W - PAD * 2, thick);
    else for (let x = PAD; x < W - PAD; x += 12) ctx.fillRect(x, y, 6, thick);
    y += thick;
  };
  const bar = (label, size = 30, height = 52) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, y, W, height);
    const top = y; y += (height - size) / 2 - 2;
    text(label, size, { bold: true, align: 'center', color: '#fff' });
    y = top + height;
  };

  // ===== LOGO
  if (logoPath) {
    try {
      const img = await loadImage(logoPath);
      const maxW = W * 0.9, maxH = 200;
      const s = Math.min(maxW / img.width, maxH / img.height);
      const w = Math.round(img.width * s), h = Math.round(img.height * s);
      const x = Math.round((W - w) / 2);
      ctx.drawImage(img, x, y, w, h);
      toMono(ctx, x, y, w, h);
      y += h + 10;
    } catch (e) { console.error('logo load failed', e.message); }
  } else {
    text(storeName.toUpperCase(), 34, { bold: true, align: 'center' }); y += 42;
  }
  if (storeLine) { text(storeLine, 20, { align: 'center' }); y += 30; }
  y += 6;

  // ===== ORDER HEADER (Uber-style: type bar, customer name huge, order #)
  const type = fulfillmentType(order);
  const typeLabel = type.includes('DELIVER') ? 'DELIVERY' : type.includes('PICK') ? 'PICKUP' : type;
  bar((opts.typePrefix ?? 'ONLINE ORDER') + ' ' + typeLabel, 32, 54); y += 14;

  const c = order.customer || {};
  const sa = order.shipping_address || order.billing_address || {};
  const name = [c.first_name || sa.first_name, c.last_name || sa.last_name].filter(Boolean).join(' ') || 'Guest';
  font(52, true);
  for (const l of wrap(ctx, clean(name), W - PAD * 2)) { text(l, 52, { bold: true, align: 'center' }); y += 58; }
  text('Order ' + (order.name || '#' + order.order_number), 34, { bold: true, align: 'center' }); y += 46;

  const when = attr(order, 'Pickup Date', 'Delivery Date', 'Date', 'Event Date');
  const noteTime = timeFromNote(order.note);
  const time = attr(order, 'Pickup Time', 'Delivery Time', 'Time', 'Event Time') || noteTime.time;
  const noteBody = noteTime.time ? noteTime.rest : (order.note || '');
  if (when || time) {
    ctx.lineWidth = 4; ctx.strokeStyle = '#000';
    ctx.strokeRect(PAD + 2, y, W - PAD * 2 - 4, 92);
    y += 10; text(type.includes('DELIVER') ? 'DELIVER AT' : 'PICKUP AT', 20, { bold: true, align: 'center' });
    y += 28; text([when, time].filter(Boolean).join('  ·  '), 36, { bold: true, align: 'center' });
    y += 64;
  } else {
    text('ASAP', 36, { bold: true, align: 'center' }); y += 48;
  }

  const placed = new Date(order.processed_at || order.created_at || Date.now());
  text('Placed ' + placed.toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }), 20, { align: 'center' });
  y += 34;

  // ===== CUSTOMER CONTACT
  const phone = sa.phone || c.phone || order.phone;
  const hasContact = phone || (type.includes('DELIVER') && order.shipping_address);
  if (hasContact) {
    rule(2); y += 12;
    if (phone) { text('Phone: ' + phone, 24, { bold: true }); y += 32; }
    if (type.includes('DELIVER') && order.shipping_address) {
      font(24);
      const addr = [sa.address1, sa.address2].filter(Boolean).join(', ');
      const city = [sa.city, sa.province_code, sa.zip].filter(Boolean).join(' ');
      for (const l of wrap(ctx, addr, W - PAD * 2)) { text(l, 24); y += 30; }
      if (city) { text(city, 24); y += 30; }
      if (sa.company) { text(sa.company, 22); y += 28; }
    }
    y += 6;
  }

  // ===== ITEMS: one row per line item, qty column | name (wraps) | price column
  rule(4); y += 12;
  const itemCount = (order.line_items || []).reduce((s, li) => s + (li.quantity || 0), 0);
  text(`${itemCount} ITEM${itemCount === 1 ? '' : 'S'}`, 22, { bold: true }); y += 36;

  const QTY_W = 78;
  for (const li of order.line_items || []) {
    if (li.current_quantity === 0) continue; // fully removed via edit
    const qty = li.current_quantity ?? li.quantity;
    const rowTop = y;
    text(qty + 'x', 32, { bold: true });
    const priceStr = money(parseFloat(li.price) * qty);
    font(24); const priceW = ctx.measureText(priceStr).width;
    font(30, true);
    const lines = wrap(ctx, clean(li.title), W - PAD * 2 - QTY_W - priceW - 14);
    lines.forEach((l, i) => {
      text(l, 30, { bold: true, x: PAD + QTY_W });
      if (i === 0) { const t = y; y += 4; text(priceStr, 24, { align: 'right' }); y = t; }
      y += 36;
    });

    const subs = [];
    if (li.variant_title && li.variant_title !== 'Default Title') subs.push(...li.variant_title.split(' / '));
    for (const p of li.properties || []) {
      if (!p.name || p.name.startsWith('_') || p.value === '' || p.value == null) continue;
      subs.push(`${p.name}: ${p.value}`);
    }
    font(24);
    for (const s of subs) {
      wrap(ctx, clean(s), W - PAD * 2 - QTY_W - 22).forEach((l, i) => {
        if (i === 0) text('•', 24, { x: PAD + QTY_W });
        text(l, 24, { x: PAD + QTY_W + 22 }); y += 30;
      });
    }
    y = Math.max(y, rowTop + 44) + 10;
    rule(1, true); y += 14;
  }

  // ===== SPECIAL INSTRUCTIONS
  if (noteBody && clean(noteBody)) {
    bar('SPECIAL INSTRUCTIONS', 24, 42);
    font(28, true);
    const lines = wrap(ctx, clean(noteBody), W - PAD * 2 - 24);
    const boxH = lines.length * 36 + 22;
    ctx.lineWidth = 5; ctx.strokeStyle = '#000'; ctx.strokeRect(2.5, y, W - 5, boxH);
    y += 12;
    for (const l of lines) { text(l, 28, { bold: true, x: PAD + 10 }); y += 36; }
    y += 24;
  }

  // ===== TOTALS
  y += 4;
  const row = (label, val, big = false) => {
    text(label, big ? 34 : 24, { bold: big }); text(val, big ? 34 : 24, { bold: big, align: 'right' });
    y += big ? 46 : 32;
  };
  row('Subtotal', money(order.current_subtotal_price ?? order.subtotal_price));
  const codes = (order.discount_codes || []).map(d => d.code).filter(Boolean);
  const disc = parseFloat(order.current_total_discounts ?? order.total_discounts ?? 0);
  if (disc > 0) row('Discount' + (codes.length ? ` (${codes.join(', ')})` : ''), '-' + money(disc));
  const ship = (order.shipping_lines || []).reduce((s, l) => s + parseFloat(l.discounted_price ?? l.price ?? 0), 0);
  if (ship > 0) row(type.includes('DELIVER') ? 'Delivery fee' : 'Shipping', money(ship));
  row('Tax', money(order.current_total_tax ?? order.total_tax));
  const tip = parseFloat(order.total_tip_received || 0);
  if (tip > 0) row('Tip', money(tip));
  y += 4; rule(4); y += 10;
  row('TOTAL', money(order.current_total_price ?? order.total_price), true);
  const paid = (order.financial_status || '').toUpperCase();
  if (paid) { y += 4; bar(paid === 'PAID' ? 'PAID' : `NOT PAID - ${paid.replace('_', ' ')}`, 26, 44); }

  // ===== PROMO
  if (hasPromo) {
    y += 22; rule(2, true); y += 22;
    if (promo.title) {
      font(36, true);
      for (const l of wrap(ctx, promo.title, W - PAD * 2)) { text(l, 36, { bold: true, align: 'center' }); y += 44; }
    }
    if (promo.text) {
      font(24);
      for (const l of wrap(ctx, promo.text, W - PAD * 2 - 20)) { text(l, 24, { align: 'center' }); y += 31; }
      y += 6;
    }
    if (promo.code) {
      y += 6;
      font(34, true);
      const cw = Math.min(W - PAD * 2, ctx.measureText(promo.code).width + 70);
      ctx.setLineDash([10, 6]); ctx.lineWidth = 3; ctx.strokeStyle = '#000';
      ctx.strokeRect((W - cw) / 2, y, cw, 62); ctx.setLineDash([]);
      y += 13; text(promo.code, 34, { bold: true, align: 'center' }); y += 62;
    }
    if (promo.qrUrl) {
      y += 8;
      const qr = await QRCode.toBuffer(promo.qrUrl, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
      const qi = await loadImage(qr);
      ctx.drawImage(qi, (W - 220) / 2, y, 220, 220); y += 228;
      if (promo.qrCaption) { text(promo.qrCaption, 22, { bold: true, align: 'center' }); y += 32; }
    }
  }

  y += 16;
  const footer = opts.footer ?? process.env.FOOTER;
  if (footer) { font(20); for (const l of wrap(ctx, footer, W - PAD * 2)) { text(l, 20, { align: 'center' }); y += 26; } }
  y += 40;

  const out = createCanvas(W, Math.ceil(y));
  out.getContext('2d').drawImage(canvas, 0, 0);
  const hgt = Math.ceil(y);
  const data = out.getContext('2d').getImageData(0, 0, W, hgt).data;
  if (opts.format === 'starprnt') return encodeStarPrnt(data, W, hgt);
  return encodeMonoPng(data, W, hgt);
}

module.exports = { renderReceipt };
