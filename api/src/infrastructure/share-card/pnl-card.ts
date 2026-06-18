import type { ClosedPosition } from '@meteora/shared';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { shareCardAsset } from './assets';
import { selectBackground } from './select-background';

// A faithful reproduction of the original SOLDecoderBot PnL card: a 1536×1024 PNG that composites
// the position figures over a mood background (happy / sad / default). Layout, fonts, colours and
// glow match the original 1:1; the only change is the data source (a ClosedPosition + a live
// SOL→USD price) and graceful handling when the USD price is unavailable.

GlobalFonts.registerFromPath(shareCardAsset('VarelaRound-Regular.ttf'), 'Varela Round');

const WIDTH = 1536;
const HEIGHT = 1024;
const MARGIN = 50;
const LINE_GAP = 100;

const WHITE = '#f8f8f8';
const GOLD = '#ffd700';
const GREEN = '#66ff66';
const RED = '#ff6666';

/** Sign + colour for a signed figure: positive green, negative red, zero gold. */
function fmtValue(value: number): { sign: string; color: string } {
  if (value > 0) return { sign: '+', color: GREEN };
  if (value < 0) return { sign: '-', color: RED };
  return { sign: '', color: GOLD };
}

/** Splits a duration into whole hours + minutes, carrying a 60-minute round up. */
function splitDuration(seconds: number): { hours: number; minutes: number } {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}

/** Renders the PnL share card for a closed position. `solUsd` null → USD figures are omitted. */
export async function renderClosedPnlCard(
  p: ClosedPosition,
  solUsd: number | null,
): Promise<Buffer> {
  const pnlSol = p.pnlSol;
  const pct = p.pnlPctSol;
  const tvlSol = p.depositSol;

  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');

  const bg = await loadImage(shareCardAsset(selectBackground(pct)));
  ctx.drawImage(bg, 0, 0, WIDTH, HEIGHT);

  const x = WIDTH - MARGIN;
  const topY = MARGIN + LINE_GAP;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';

  const setGlow = (color: string, blur: number) => {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
  };

  // --- 1) Pair, right-aligned: near-white symbols around a gold slash ---
  ctx.font = 'bold 72px "Varela Round"';
  const wLeft = ctx.measureText(p.tokenX).width;
  const wSlash = ctx.measureText('/').width;
  const startXPair = x - (wLeft + wSlash + ctx.measureText(p.tokenY).width);
  ctx.fillStyle = WHITE;
  setGlow(GOLD, 10);
  ctx.fillText(p.tokenX, startXPair, topY);
  ctx.fillStyle = GOLD;
  setGlow(WHITE, 20);
  ctx.fillText('/', startXPair + wLeft, topY);
  ctx.fillStyle = WHITE;
  setGlow(GOLD, 20);
  ctx.fillText(p.tokenY, startXPair + wLeft + wSlash, topY);

  // --- 2) Profit line: USD (coloured) + SOL (near-white), or SOL-only when no USD price ---
  ctx.font = 'bold 72px "Varela Round"';
  let primaryText: string;
  let primaryColor: string;
  let secondaryText: string;
  if (solUsd != null) {
    const usd = pnlSol * solUsd;
    primaryText = `${fmtValue(usd).sign}$${Math.abs(usd).toFixed(2)}`;
    primaryColor = fmtValue(usd).color;
    secondaryText =
      pnlSol !== 0 ? ` (${fmtValue(pnlSol).sign}${Math.abs(pnlSol).toFixed(2)} SOL)` : '';
  } else {
    primaryText = `${fmtValue(pnlSol).sign}${Math.abs(pnlSol).toFixed(2)} SOL`;
    primaryColor = fmtValue(pnlSol).color;
    secondaryText = '';
  }
  const wSecondary = ctx.measureText(secondaryText).width;
  ctx.fillStyle = primaryColor;
  setGlow(primaryColor, 30);
  ctx.fillText(primaryText, x - (ctx.measureText(primaryText).width + wSecondary), topY + LINE_GAP);
  ctx.fillStyle = WHITE;
  setGlow(GOLD, 10);
  ctx.fillText(secondaryText, x - wSecondary, topY + LINE_GAP);

  // --- 3) Elapsed time, right-aligned: near-white numbers, gold units ---
  ctx.font = 'bold 48px "Varela Round"';
  const { hours, minutes } = splitDuration(p.durationSeconds ?? 0);
  const num1 = `${hours}`;
  const unit1 = 'h';
  const num2 = minutes.toString().padStart(2, '0');
  const unit2 = 'mn';
  const wNum1 = ctx.measureText(num1).width;
  const wUnit1 = ctx.measureText(unit1).width;
  const wNum2 = ctx.measureText(num2).width;
  const startXTime = x - (wNum1 + wUnit1 + wNum2 + ctx.measureText(unit2).width);
  const timeY = topY + LINE_GAP * 2;
  ctx.fillStyle = WHITE;
  setGlow('#ffff00', 10);
  ctx.fillText(num1, startXTime, timeY);
  ctx.fillStyle = GOLD;
  setGlow(GOLD, 20);
  ctx.fillText(unit1, startXTime + wNum1, timeY);
  ctx.fillStyle = WHITE;
  setGlow(GOLD, 10);
  ctx.fillText(num2, startXTime + wNum1 + wUnit1, timeY);
  ctx.fillStyle = GOLD;
  setGlow(GOLD, 20);
  ctx.fillText(unit2, startXTime + wNum1 + wUnit1 + wNum2, timeY);

  // --- 4) Bottom metrics: PNL % then TVL ---
  const bottomY = HEIGHT - MARGIN - LINE_GAP;
  ctx.font = 'bold 48px "Varela Round"';

  const pnlLabel = 'PNL: ';
  const pnlValue = `${fmtValue(pct).sign}${Math.abs(pct).toFixed(2)}%`;
  const wPnlLabel = ctx.measureText(pnlLabel).width;
  const startXPnl = x - (wPnlLabel + ctx.measureText(pnlValue).width);
  const pnlY = bottomY + LINE_GAP * 0.2;
  ctx.fillStyle = GOLD;
  setGlow(GOLD, 10);
  ctx.fillText(pnlLabel, startXPnl, pnlY);
  ctx.fillStyle = fmtValue(pct).color;
  setGlow(fmtValue(pct).color, 20);
  ctx.fillText(pnlValue, startXPnl + wPnlLabel, pnlY);

  const tvlLabel = 'TVL: ';
  const tvlValue =
    solUsd != null
      ? `${tvlSol.toFixed(2)} SOL ($${(tvlSol * solUsd).toFixed(0)})`
      : `${tvlSol.toFixed(2)} SOL`;
  const wTvlLabel = ctx.measureText(tvlLabel).width;
  const startXTvl = x - (wTvlLabel + ctx.measureText(tvlValue).width);
  ctx.fillStyle = GOLD;
  setGlow(GOLD, 20);
  ctx.fillText(tvlLabel, startXTvl, bottomY + LINE_GAP);
  ctx.fillStyle = WHITE;
  setGlow(GOLD, 10);
  ctx.fillText(tvlValue, startXTvl + wTvlLabel, bottomY + LINE_GAP);

  return canvas.encode('png');
}
