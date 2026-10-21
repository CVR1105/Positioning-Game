'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../server/engine');

test('demand map matches the brief', () => {
  assert.equal(E.demandOf('A10'), 1500);
  assert.equal(E.demandOf('D3'), 800);
  assert.equal(E.demandOf('H3'), 1000);
  assert.equal(E.demandOf('I8'), 800);
  assert.equal(E.demandOf('J1'), 0);
});

test('positioning costs: H3 from START is 800, A10 is 3600', () => {
  assert.equal(E.moveCost(E.START, 'H3'), 800);
  assert.equal(E.moveCost(E.START, 'A10'), 3600);
  assert.equal(E.moveCost('D7', 'D7'), 0);
  assert.equal(E.moveCost('D7', 'A1'), 1800); // workbook repositioning example
});

test('cell validation', () => {
  assert.ok(E.isValidCell('A10'));
  assert.ok(E.isValidCell('J1'));
  assert.ok(!E.isValidCell('K1'));
  assert.ok(!E.isValidCell('A11'));
  assert.ok(!E.isValidCell('a1'));
  assert.ok(!E.isValidCell('A0'));
});

test('demand is split equally between products in a cell', () => {
  const r = E.resolveRound([
    { teamId: 1, accumulated: 5000, products: [{ id: 'a', prevCell: null, cell: 'H3', prevSales: 0, prevBonus: 0 }] },
    { teamId: 2, accumulated: 5000, products: [{ id: 'b', prevCell: null, cell: 'H3', prevSales: 0, prevBonus: 0 }] },
  ]);
  assert.equal(r.products[0].sales, 500);
  assert.equal(r.products[1].sales, 500);
  assert.equal(r.teams[0].cost, 800);
  assert.equal(r.teams[0].net, -300);
  assert.equal(r.teams[0].accumulated, 4700);
  assert.equal(r.cellCounts.H3, 2);
});

test('loyalty bonus compounds at 10% for unmoved products (≈95% by round 8)', () => {
  let prevSales = 0;
  let prevBonus = 0;
  let prevCell = null;
  const sales = [];
  for (let round = 1; round <= 8; round++) {
    const r = E.resolveRound([
      { teamId: 1, accumulated: 0, products: [{ id: 'p', prevCell, cell: 'D5', prevSales, prevBonus }] },
    ]);
    const p = r.products[0];
    sales.push(p.sales);
    prevSales = p.sales;
    prevBonus = p.cumBonus;
    prevCell = 'D5';
  }
  // D5 = 200 demand. 200, 220, 242, 266.2→267, ...
  assert.deepEqual(sales.slice(0, 3), [200, 220, 242]);
  assert.ok(sales[7] >= 389 && sales[7] <= 392, `round 8 sales ${sales[7]}`);
});

test('moving a product resets loyalty and charges 200/step', () => {
  const r = E.resolveRound([
    { teamId: 1, accumulated: 1000, products: [{ id: 'p', prevCell: 'D5', cell: 'D4', prevSales: 500, prevBonus: 50 }] },
  ]);
  assert.equal(r.products[0].loyalty, 0);
  assert.equal(r.products[0].sales, 400);
  assert.equal(r.products[0].cost, 200);
});

test('incumbent keeps loyalty when challenged; new entrant gets only its share', () => {
  const r = E.resolveRound([
    { teamId: 1, accumulated: 0, products: [{ id: 'p', prevCell: 'G2', cell: 'G2', prevSales: 300, prevBonus: 0 }] },
    { teamId: 2, accumulated: 0, products: [{ id: 'q', prevCell: null, cell: 'G2', prevSales: 0, prevBonus: 0 }] },
  ]);
  assert.equal(r.products[0].sales, 150 + 30);
  assert.equal(r.products[1].sales, 150);
});

test('products left in START earn nothing and do not count as competitors', () => {
  const r = E.resolveRound([
    { teamId: 1, accumulated: 5000, products: [{ id: 'p', prevCell: null, cell: 'J1', prevSales: 0, prevBonus: 0 }] },
  ]);
  assert.equal(r.products[0].sales, 0);
  assert.equal(r.products[0].cost, 0);
  assert.equal(r.cellCounts.J1, undefined);
});

test('ranking handles ties', () => {
  const r = E.resolveRound([
    { teamId: 1, accumulated: 5000, products: [] },
    { teamId: 2, accumulated: 5000, products: [] },
    { teamId: 3, accumulated: 4000, products: [] },
  ]);
  assert.deepEqual(r.teams.map((t) => t.overallRank), [1, 1, 3]);
});

test('planCost prices new and existing products', () => {
  const pc = E.planCost([{ id: 1, cell: 'H3' }], [{ id: 1, cell: 'H3' }, { id: 'n', cell: 'I8' }]);
  assert.equal(pc.lines[0].cost, 0);
  assert.equal(pc.lines[1].cost, 1600);
  assert.equal(pc.total, 1600);
});
