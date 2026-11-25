import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatKwh, formatLimitPct, formatMoney, formatMoneyExact, formatRate, formatTokensExact, kindLabel } from './format'

test('formatMoney: USD auto decimals keep the existing pill rule ($0.0042 below a cent, else 3 decimals)', () => {
  assert.equal(formatMoney(0.0042), '$0.0042')
  assert.equal(formatMoney(0.00999), '$0.0100')
  assert.equal(formatMoney(0.01), '$0.010')
  assert.equal(formatMoney(0.1431), '$0.143')
  assert.equal(formatMoney(12.3456), '$12.346')
  assert.equal(formatMoney(0), '$0.0000')
  assert.equal(formatMoney(1234.5), '$1,234.500')
})

test('formatMoney: other currencies, zero-decimal currencies, fixed decimals, estimate prefix, non-finite', () => {
  assert.equal(formatMoney(0.1431, 'EUR'), '€0.143')
  assert.equal(formatMoney(0.0042, 'EUR'), '€0.0042')
  assert.equal(formatMoney(12.3456, 'JPY'), '¥12.3')
  assert.equal(formatMoney(0.4, 'JPY'), '¥0.4')
  assert.equal(formatMoney(1.2345, 'USD', { decimals: 2 }), '$1.23')
  assert.equal(formatMoney(1.2345, 'USD', { decimals: 'auto' }), '$1.235')
  assert.equal(formatMoney(0.001, 'USD', { estimate: true }), '~$0.0010')
  assert.equal(formatMoney(Number.NaN), '?')
  assert.equal(formatMoney(Number.POSITIVE_INFINITY), '?')
  assert.equal(formatMoney(1, 'XXXX'), 'XXXX 1.000', 'an invalid currency code does not throw')
})

test('formatMoneyExact: up to 6 decimals, minimum the currency minor unit', () => {
  assert.equal(formatMoneyExact(2.525), '$2.525')
  assert.equal(formatMoneyExact(2), '$2.00')
  assert.equal(formatMoneyExact(0.001675), '$0.001675')
  assert.equal(formatMoneyExact(9.2, 'EUR'), '€9.20')
  assert.equal(formatMoneyExact(Number.NaN), '?')
})

test('formatRate, formatTokensExact, kindLabel', () => {
  assert.equal(formatRate(10), '10.00'); assert.equal(formatRate(0.1), '0.10'); assert.equal(formatRate(0.125), '0.125')
  assert.equal(formatRate(3.75), '3.75'); assert.equal(formatRate(0.92), '0.92'); assert.equal(formatRate(1 / 3), '0.333333')
  assert.equal(formatRate(Number.NaN), '?')
  assert.equal(formatTokensExact(15317), '15,317'); assert.equal(formatTokensExact(0), '0'); assert.equal(formatTokensExact(1234567.6), '1,234,568')
  assert.equal(kindLabel('list-equivalent'), 'list-equiv'); assert.equal(kindLabel('billed'), 'billed')
  assert.equal(kindLabel('estimated'), 'estimated'); assert.equal(kindLabel('unpriced'), 'unpriced')
})

test('formatKwh: precision shrinks with magnitude', () => {
  assert.equal(formatKwh(0), '0 kWh')
  assert.equal(formatKwh(1.2345), '1.23 kWh')
  assert.equal(formatKwh(0.0142), '0.014 kWh')
  assert.equal(formatKwh(0.0005), '0.0005 kWh')
  assert.equal(formatKwh(0.00001), '<0.0001 kWh')
  assert.equal(formatKwh(-1), '?'); assert.equal(formatKwh(Number.NaN), '?')
})

test('formatLimitPct: per-mille below 1%, one decimal below 10%, integers above', () => {
  const pct = (v: number, k?: 'observed' | 'estimate' | 'lower-bound') => formatLimitPct(v / 100, k)
  assert.equal(pct(0), '0%')
  assert.equal(pct(0.004), '<0.1‰')
  assert.equal(pct(0.04), '0.4‰')
  assert.equal(pct(0.5), '5.0‰')
  assert.equal(pct(0.9), '9.0‰')
  assert.equal(pct(1), '1.0%')
  assert.equal(pct(4.26), '4.3%')
  assert.equal(pct(9.99), '10%', 'the band is chosen from the rounded value, never "10.0%"')
  assert.equal(pct(9.94), '9.9%')
  assert.equal(pct(10), '10%')
  assert.equal(pct(42.4), '42%')
  assert.equal(pct(99.4), '99%')
  assert.equal(pct(99.6), '100%')
  assert.equal(pct(100), '100%')
  assert.equal(pct(137), '100%', 'observed values cap at 100%')
})

test('formatLimitPct: estimate and lower-bound prefixes; 0.0999% rounds up into the 1% band', () => {
  assert.equal(pct2(0.04, 'estimate'), '~0.4‰')
  assert.equal(pct2(4.26, 'estimate'), '~4.3%')
  assert.equal(pct2(42, 'estimate'), '~42%')
  assert.equal(pct2(0.004, 'estimate'), '~<0.1‰')
  assert.equal(pct2(0, 'estimate'), '~0%')
  assert.equal(pct2(42, 'lower-bound'), '>=42%')
  assert.equal(pct2(120, 'estimate'), '>=100%')
  assert.equal(pct2(120, 'lower-bound'), '>=100%')
  assert.equal(pct2(99.96, 'observed'), '100%')
  assert.equal(pct2(0.9996, 'observed'), '1.0%')
  assert.equal(formatLimitPct(Number.NaN), '–'); assert.equal(formatLimitPct(-0.1), '–'); assert.equal(formatLimitPct(Number.POSITIVE_INFINITY), '–')
})

function pct2(v: number, k: 'observed' | 'estimate' | 'lower-bound'): string { return formatLimitPct(v / 100, k) }
