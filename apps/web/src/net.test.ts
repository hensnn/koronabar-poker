import { beforeEach, describe, expect, it } from 'vitest';
import type { TableView } from '@kb/game-core';
import { acceptsView, clockOffsetFrom, dropView, netState, receiveTableView, resetViewTracking } from './net';

const view = (seq: number): TableView => ({ seq, handId: `h${seq}` }) as unknown as TableView;

describe('pohledy na stůl podle pořadového čísla', () => {
  beforeEach(() => {
    resetViewTracking();
    dropView('t1');
  });

  it('přijme se jen pohled se stejným nebo vyšším seq; opožděná starší zpráva se zahodí', () => {
    receiveTableView({ tableId: 't1', view: view(5), serverTime: 1000 }, 1000);
    receiveTableView({ tableId: 't1', view: view(3), serverTime: 1000 }, 1000);
    expect(netState().views.t1!.seq).toBe(5);
    receiveTableView({ tableId: 't1', view: view(6), serverTime: 1000 }, 1000);
    expect(netState().views.t1!.seq).toBe(6);
  });

  it('pořadí se hlídá pro každý stůl zvlášť a starý server bez seq projde vždy', () => {
    expect(acceptsView(undefined, 1)).toBe(true);
    expect(acceptsView(7, undefined)).toBe(true);
    expect(acceptsView(7, 7)).toBe(true);
    expect(acceptsView(7, 6)).toBe(false);
  });

  it('po odhlášení odběru pohled zmizí a další přijatý se bere bez ohledu na seq (po restartu serveru začíná znovu)', () => {
    receiveTableView({ tableId: 't1', view: view(9), serverTime: 0 }, 0);
    dropView('t1');
    expect(netState().views.t1).toBeUndefined();
    receiveTableView({ tableId: 't1', view: view(1), serverTime: 0 }, 0);
    expect(netState().views.t1!.seq).toBe(1);
  });
});

describe('vyhlazený rozdíl hodin', () => {
  it('bere největší vzorek z okna (zpráva s nejmenším zpožděním), takže odpočet s každou zprávou neposkakuje', () => {
    expect(clockOffsetFrom([])).toBe(0);
    // skutečný rozdíl 1000 ms, zpoždění doručení 20 až 300 ms
    expect(clockOffsetFrom([1000 - 120, 1000 - 20, 1000 - 300])).toBe(980);
  });

  it('vzorky se sbírají z přijatých pohledů', () => {
    resetViewTracking();
    receiveTableView({ tableId: 't2', view: view(1), serverTime: 10_000 }, 9_500);
    receiveTableView({ tableId: 't2', view: view(2), serverTime: 10_100 }, 9_300);
    expect(netState().clockOffset).toBe(800);
    dropView('t2');
  });
});
