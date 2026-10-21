'use strict';
// Pure game rules for the Marketing & Positioning Simulation.
// Mirrors the 2020 decision workbook: demand map, 200 pts per orthogonal step,
// equal split of a cell's demand, and a 10% compounding loyalty bonus for
// products that are not repositioned.

const ROWS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']; // A = high style/look, J = basic
const COLS = 10; // 1 = low quality, 10 = high quality

// Demand per cell (points/sales). J1 is START and generates nothing.
const DEMAND = {
  A: [50, 50, 100, 50, 100, 150, 300, 600, 1000, 1500],
  B: [50, 100, 200, 100, 50, 100, 150, 300, 600, 1000],
  C: [100, 200, 400, 200, 100, 50, 100, 150, 300, 600],
  D: [200, 400, 800, 400, 200, 100, 50, 100, 150, 300],
  E: [100, 200, 400, 200, 100, 50, 100, 50, 100, 150],
  F: [100, 150, 300, 150, 100, 50, 50, 100, 50, 100],
  G: [150, 300, 600, 300, 150, 50, 100, 200, 100, 50],
  H: [300, 600, 1000, 600, 300, 100, 200, 400, 200, 100],
  I: [150, 300, 600, 300, 150, 200, 400, 800, 400, 200],
  J: [0, 150, 300, 150, 50, 100, 200, 400, 200, 100],
};

const START = 'J1';
const MOVE_COST = 200;
const STARTING_BUDGET = 5000;
const LOYALTY_RATE = 0.1;
const MAX_PRODUCTS = 20;
const MAX_ROUNDS = 8;
const MAX_TEAMS = 10;

const SEGMENTS = [
  { cell: 'A10', name: 'Status Seekers', blurb: 'Best quality and best style, happy to pay for it.' },
  { cell: 'D3', name: 'Fashion Conscious', blurb: 'Good-looking products, will trade quality for price.' },
  { cell: 'H3', name: 'Budget Conscious', blurb: 'Basic look, lower quality, lowest price.' },
  { cell: 'I8', name: 'Quality Focused', blurb: 'High quality, not fussed about style.' },
];

const CELL_RE = /^([A-J])(10|[1-9])$/;

function isValidCell(cell) {
  return typeof cell === 'string' && CELL_RE.test(cell);
}

function parseCell(cell) {
  const m = CELL_RE.exec(cell);
  if (!m) throw new Error(`Invalid cell: ${cell}`);
  return { row: ROWS.indexOf(m[1]), col: Number(m[2]) - 1 };
}

function demandOf(cell) {
  const { row, col } = parseCell(cell);
  return DEMAND[ROWS[row]][col];
}

function distance(a, b) {
  const p = parseCell(a);
  const q = parseCell(b);
  return Math.abs(p.row - q.row) + Math.abs(p.col - q.col);
}

function moveCost(from, to) {
  return distance(from, to) * MOVE_COST;
}

function allCells() {
  const out = [];
  for (const r of ROWS) for (let c = 1; c <= COLS; c++) out.push(r + c);
  return out;
}

function segmentOf(cell) {
  return SEGMENTS.find((s) => s.cell === cell) || null;
}

/**
 * Cost of a team's plan for one round.
 * @param {Array<{id:any, cell:string, isNew?:boolean}>} current  products already in market (with current cell)
 * @param {Array<{id:any, cell:string}>} plan  desired cell per product id; ids not in `current` are new products
 */
function planCost(current, plan) {
  const byId = new Map(current.map((p) => [String(p.id), p.cell]));
  let total = 0;
  const lines = plan.map((p) => {
    const from = byId.has(String(p.id)) ? byId.get(String(p.id)) : START;
    const cost = moveCost(from, p.cell);
    total += cost;
    return { id: p.id, from, to: p.cell, moves: cost / MOVE_COST, cost, isNew: !byId.has(String(p.id)) };
  });
  return { total, lines };
}

/**
 * Resolve one round for all teams.
 *
 * @param {Array<{
 *   teamId:any,
 *   accumulated:number,                      // accumulated profit before this round (5000 at start)
 *   products: Array<{
 *     id:any,
 *     prevCell:string|null,                  // null => new product introduced this round
 *     cell:string,                           // cell after this round's decision
 *     prevSales:number,                      // last round's total sales (0 if new)
 *     prevBonus:number                       // last round's cumulative loyalty bonus (float)
 *   }>
 * }>} teams
 * @returns {{ teams: Array, products: Array, cellCounts: Object, market: Object }}
 */
function resolveRound(teams) {
  const cellCounts = {};
  for (const t of teams) {
    for (const p of t.products) {
      if (p.cell === START) continue;
      cellCounts[p.cell] = (cellCounts[p.cell] || 0) + 1;
    }
  }

  const productResults = [];
  const teamResults = teams.map((t) => {
    let sales = 0;
    let cost = 0;
    let best = 0;
    let loyaltyTotal = 0;
    for (const p of t.products) {
      const isNew = p.prevCell == null;
      const from = isNew ? START : p.prevCell;
      const pCost = moveCost(from, p.cell);
      const moved = isNew || from !== p.cell;
      const count = p.cell === START ? 0 : cellCounts[p.cell];
      const base = count > 0 ? Math.round(demandOf(p.cell) / count) : 0;

      // Workbook: bonus_r = 0.1 * sales_{r-1} (only if unmoved and previous sales > 0),
      // cumulative bonus = bonus_r + cumulative_{r-1}, sales = base + ROUNDUP(cumulative).
      let cumBonus = 0;
      if (!moved && p.prevSales > 0) {
        cumBonus = LOYALTY_RATE * p.prevSales + (p.prevBonus || 0);
      }
      const loyalty = cumBonus > 0 ? Math.ceil(cumBonus - 1e-9) : 0;
      const pSales = base + loyalty;

      sales += pSales;
      cost += pCost;
      loyaltyTotal += loyalty;
      if (pSales > best) best = pSales;
      productResults.push({
        teamId: t.teamId,
        productId: p.id,
        from,
        cell: p.cell,
        isNew,
        moved,
        competitors: count,
        base,
        loyalty,
        cumBonus,
        sales: pSales,
        cost: pCost,
      });
    }
    const net = sales - cost;
    return {
      teamId: t.teamId,
      sales,
      cost,
      net,
      best,
      loyalty: loyaltyTotal,
      productCount: t.products.length,
      accumulated: t.accumulated + net,
    };
  });

  const totalSales = teamResults.reduce((s, r) => s + r.sales, 0);
  for (const r of teamResults) r.share = totalSales > 0 ? r.sales / totalSales : 0;
  rank(teamResults, 'net', 'roundRank');
  rank(teamResults, 'accumulated', 'overallRank');

  const n = teamResults.length || 1;
  const sum = (k) => teamResults.reduce((s, r) => s + r[k], 0);
  const market = {
    totalSales,
    totalCost: sum('cost'),
    totalNet: sum('net'),
    totalProducts: sum('productCount'),
    avgSales: totalSales / n,
    avgCost: sum('cost') / n,
    avgNet: sum('net') / n,
    avgAccumulated: sum('accumulated') / n,
  };

  return { teams: teamResults, products: productResults, cellCounts, market };
}

// Standard competition ranking (1,2,2,4) on a numeric field, highest first.
function rank(rows, field, out) {
  const sorted = [...rows].sort((a, b) => b[field] - a[field]);
  sorted.forEach((r, i) => {
    r[out] = i > 0 && sorted[i - 1][field] === r[field] ? sorted[i - 1][out] : i + 1;
  });
}

module.exports = {
  ROWS,
  COLS,
  DEMAND,
  START,
  MOVE_COST,
  STARTING_BUDGET,
  LOYALTY_RATE,
  MAX_PRODUCTS,
  MAX_ROUNDS,
  MAX_TEAMS,
  SEGMENTS,
  isValidCell,
  parseCell,
  demandOf,
  distance,
  moveCost,
  allCells,
  segmentOf,
  planCost,
  resolveRound,
};
