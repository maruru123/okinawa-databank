#!/usr/bin/env node
// 沖縄トラベル実績DB ― 気象庁データ収集スクリプト
//
// 使い方:
//   node scripts/collect.mjs hourly   台風・警報・アメダス毎時スナップ
//   node scripts/collect.mjs daily    前日(JST)のアメダス日値サマリ
//
// 設計上の約束（HANDOFF.md より）:
//   - 追記専用。過去レコードの書き換え・削除はしない
//   - 全レコードが fetched_at(JST) と source_url を持つ
//   - 取得失敗も同じ JSONL に error レコードとして記録し、プロセスは exit 1 で終わる
//   - タイムゾーンは実行環境に依存しない（UTC ランナーでもずれない）

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const STATE_FILE = join(ROOT, 'state', 'last_seen.json');
const SOURCE = '気象庁';
const BASE = 'https://www.jma.go.jp/bosai';

// 沖縄県の府県予報区（area.json の offices を M1 で実測して確定）
const WARNING_OFFICES = [
  ['471000', '沖縄本島地方'],
  ['472000', '大東島地方'],
  ['473000', '宮古島地方'],
  ['474000', '八重山地方'],
];

// 日値サマリを取る官署級アメダス（気圧・湿度・日照まで持つ A/B 型。4地方をカバー）
const DAILY_STATIONS = [
  ['91197', '那覇'],
  ['91107', '名護'],
  ['91146', '久米島'],
  ['92011', '南大東'],
  ['93041', '宮古島'],
  ['94017', '与那国島'],
  ['94062', '西表島'],
  ['94081', '石垣島'],
];

// アメダス地点番号の頭2桁が 91〜94 = 沖縄県（88xxx は鹿児島県奄美なので含めない）
const OKINAWA_STATION_RE = /^9[1-4]/;

// ---------------------------------------------------------------- JST 時刻

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const p2 = (n) => String(n).padStart(2, '0');

/** epoch ms → JST の壁時計を UTC フィールドに載せた Date（getUTC* で JST が読める） */
const toJstClock = (ms) => new Date(ms + JST_OFFSET_MS);

/** epoch ms → "2026-07-27T21:50:03+09:00" */
function jstIso(ms) {
  const d = toJstClock(ms);
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}+09:00`
  );
}

/** epoch ms → { year:"2026", month:"07", date:"20260727" }（JST基準） */
function jstDateParts(ms) {
  const d = toJstClock(ms);
  const year = String(d.getUTCFullYear());
  const month = p2(d.getUTCMonth() + 1);
  const day = p2(d.getUTCDate());
  return { year, month, day, date: `${year}${month}${day}`, iso: `${year}-${month}-${day}` };
}

// ---------------------------------------------------------------- 入出力

/** data/<dataset>/<YYYY>/<MM>.jsonl に1行追記する */
async function appendRecord(dataset, parts, record) {
  const dir = join(DATA_DIR, dataset, parts.year);
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${parts.month}.jsonl`), JSON.stringify(record) + '\n', 'utf8');
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------- 取得

const failures = [];

/**
 * 気象庁から取得する。ETag を渡すと 304 のとき { notModified:true } を返す。
 * ネットワーク断・5xx は指数バックオフで3回まで再試行する。
 */
async function fetchJma(url, { etag, retries = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const headers = { 'User-Agent': 'okinawa-databank/1.0 (+github actions; jma public data)' };
      if (etag) headers['If-None-Match'] = etag;
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });

      if (res.status === 304) return { notModified: true };
      if (res.status === 404) return { status: 404, error: 'HTTP 404 Not Found' };
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const text = await res.text();
      return { status: res.status, etag: res.headers.get('etag'), text };
    } catch (err) {
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return { error: String(lastError && lastError.message ? lastError.message : lastError) };
}

/** 取得できなければ error レコードを JSONL に残して null を返す（呼び出し側は続行する） */
async function fetchJson(url, dataset, parts, { etag, extra = {} } = {}) {
  const res = await fetchJma(url, { etag });
  if (res.notModified) return { notModified: true };

  if (res.error || res.status === 404) {
    const message = res.error || 'HTTP 404 Not Found';
    await appendRecord(dataset, parts, {
      fetched_at: jstIso(Date.now()),
      source: SOURCE,
      source_url: url,
      dataset,
      ...extra,
      error: message,
    });
    failures.push(`${dataset} ${url}: ${message}`);
    return null;
  }

  try {
    return { data: JSON.parse(res.text), etag: res.etag };
  } catch (err) {
    await appendRecord(dataset, parts, {
      fetched_at: jstIso(Date.now()),
      source: SOURCE,
      source_url: url,
      dataset,
      ...extra,
      error: `JSON parse failed: ${err.message}`,
    });
    failures.push(`${dataset} ${url}: JSON parse failed`);
    return null;
  }
}

// ---------------------------------------------------------------- 収集: 警報・注意報

// 警報 JSON は「発表内容に変化があったときだけ」更新される。M1 実測では沖縄4区とも
// 2ヶ月前の Last-Modified のままだった。更新がない＝異常ではないので、
// reportDatetime が前回と同じならレコードを作らない（ETag による 304 も同義）。
async function collectWarnings(state) {
  const parts = jstDateParts(Date.now());
  state.warning ??= {};
  let appended = 0;

  for (const [code, name] of WARNING_OFFICES) {
    const url = `${BASE}/warning/data/warning/${code}.json`;
    const prev = state.warning[code] || {};
    const res = await fetchJson(url, 'warning', parts, {
      etag: prev.etag,
      extra: { office: code, office_name: name },
    });
    if (!res) continue;
    if (res.notModified) continue;

    const reportDatetime = res.data.reportDatetime ?? null;
    state.warning[code] = { etag: res.etag, report_datetime: reportDatetime };
    if (reportDatetime && reportDatetime === prev.report_datetime) continue;

    await appendRecord('warning', parts, {
      fetched_at: jstIso(Date.now()),
      source: SOURCE,
      source_url: url,
      dataset: 'warning',
      office: code,
      office_name: name,
      report_datetime: reportDatetime,
      data: res.data,
    });
    appended++;
  }
  console.log(`warning: ${appended} 件追記`);
}

// ---------------------------------------------------------------- 収集: 台風

// targetTc.json に現存台風が並ぶ（なければ []）。各台風について
// specifications.json（実況＋各予報時刻の数値）と forecast.json（予報円・暴風警戒域の図形）
// を取り、issue（発表時刻）が前回と同じならレコードを作らない。
async function collectTyphoons(state) {
  const parts = jstDateParts(Date.now());
  state.typhoon ??= {};

  const listUrl = `${BASE}/typhoon/data/targetTc.json`;
  const list = await fetchJson(listUrl, 'typhoon', parts);
  if (!list || list.notModified) return;

  const targets = Array.isArray(list.data) ? list.data : [];
  if (targets.length === 0) {
    state.typhoon = {};
    console.log('typhoon: 現存台風なし');
    return;
  }

  const seen = new Set();
  let appended = 0;

  for (const target of targets) {
    const tc = target.tropicalCyclone;
    if (!tc) continue;
    seen.add(tc);

    const issue = target.issue ?? null;
    if (issue && state.typhoon[tc]?.issue === issue) continue;

    const specUrl = `${BASE}/typhoon/data/${tc}/specifications.json`;
    const fcUrl = `${BASE}/typhoon/data/${tc}/forecast.json`;
    const extra = { tropical_cyclone: tc, typhoon_number: target.typhoonNumber ?? null };

    const spec = await fetchJson(specUrl, 'typhoon', parts, { extra });
    const fc = await fetchJson(fcUrl, 'typhoon', parts, { extra });
    if (!spec || !fc) continue;

    await appendRecord('typhoon', parts, {
      fetched_at: jstIso(Date.now()),
      source: SOURCE,
      source_url: specUrl,
      forecast_source_url: fcUrl,
      dataset: 'typhoon',
      tropical_cyclone: tc,
      typhoon_number: target.typhoonNumber ?? null,
      category: target.category ?? null,
      issue,
      specifications: spec.data,
      forecast: fc.data,
    });
    state.typhoon[tc] = { issue };
    appended++;
  }

  // 消滅した台風の状態は落とす（同じ番号が再利用されても誤って重複排除しないため）
  for (const tc of Object.keys(state.typhoon)) {
    if (!seen.has(tc)) delete state.typhoon[tc];
  }
  console.log(`typhoon: 現存 ${targets.length} 個 / ${appended} 件追記`);
}

// ---------------------------------------------------------------- 収集: アメダス毎時

// 全国スナップは 250KB あるが、沖縄34地点だけ抜くと約6KB に収まる。
// latest_time.txt が指す時刻のファイルがまだ無いことがあるので、その場合は10分戻す。
async function collectAmedasSnapshot() {
  const parts = jstDateParts(Date.now());
  const timeUrl = `${BASE}/amedas/data/latest_time.txt`;

  const res = await fetchJma(timeUrl);
  if (res.error || res.status === 404 || !res.text) {
    const message = res.error || 'HTTP 404 Not Found';
    await appendRecord('amedas', parts, {
      fetched_at: jstIso(Date.now()),
      source: SOURCE,
      source_url: timeUrl,
      dataset: 'amedas',
      error: message,
    });
    failures.push(`amedas ${timeUrl}: ${message}`);
    return;
  }

  const observedAt = res.text.trim();
  const observedMs = Date.parse(observedAt);
  if (Number.isNaN(observedMs)) {
    await appendRecord('amedas', parts, {
      fetched_at: jstIso(Date.now()),
      source: SOURCE,
      source_url: timeUrl,
      dataset: 'amedas',
      error: `latest_time.txt を時刻として解釈できない: ${JSON.stringify(observedAt.slice(0, 64))}`,
    });
    failures.push(`amedas ${timeUrl}: 時刻の解釈に失敗`);
    return;
  }

  for (const backOffMinutes of [0, 10]) {
    const ms = observedMs - backOffMinutes * 60_000;
    const d = toJstClock(ms);
    const stamp =
      `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
      `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}00`;
    const mapUrl = `${BASE}/amedas/data/map/${stamp}.json`;

    const probe = await fetchJma(mapUrl);
    if (probe.status === 404 && backOffMinutes === 0) continue; // 生成待ちとみなして10分戻す

    if (probe.error || probe.status === 404) {
      const message = probe.error || 'HTTP 404 Not Found';
      await appendRecord('amedas', parts, {
        fetched_at: jstIso(Date.now()),
        source: SOURCE,
        source_url: mapUrl,
        dataset: 'amedas',
        error: message,
      });
      failures.push(`amedas ${mapUrl}: ${message}`);
      return;
    }

    let all;
    try {
      all = JSON.parse(probe.text);
    } catch (err) {
      await appendRecord('amedas', parts, {
        fetched_at: jstIso(Date.now()),
        source: SOURCE,
        source_url: mapUrl,
        dataset: 'amedas',
        error: `JSON parse failed: ${err.message}`,
      });
      failures.push(`amedas ${mapUrl}: JSON parse failed`);
      return;
    }

    const stations = {};
    for (const [id, value] of Object.entries(all)) {
      if (OKINAWA_STATION_RE.test(id)) stations[id] = value;
    }

    await appendRecord('amedas', parts, {
      fetched_at: jstIso(Date.now()),
      source: SOURCE,
      source_url: mapUrl,
      dataset: 'amedas',
      observed_at: jstIso(ms),
      station_count: Object.keys(stations).length,
      stations,
    });
    console.log(`amedas: ${Object.keys(stations).length} 地点 @ ${jstIso(ms)}`);
    return;
  }
}

// ---------------------------------------------------------------- 収集: アメダス日値

// 対象は「JST の前日」に固定する。cron が多少遅延しても対象日がずれない。
// 21時ブロック（21:00〜23:50 の10分値18本）の最終レコードに、その日の
// 最高/最低気温（時刻付き）・最大瞬間風速・24時間降水量が入っている。
async function collectAmedasDaily() {
  const targetMs = Date.now() - 24 * 60 * 60 * 1000;
  const parts = jstDateParts(targetMs);
  let appended = 0;

  for (const [station, name] of DAILY_STATIONS) {
    const url = `${BASE}/amedas/data/point/${station}/${parts.date}_21.json`;
    const extra = { station, station_name: name, date: parts.iso };
    const res = await fetchJson(url, 'amedas_daily', parts, { extra });
    if (!res || res.notModified) continue;

    const times = Object.keys(res.data).sort();
    if (times.length === 0) {
      await appendRecord('amedas_daily', parts, {
        fetched_at: jstIso(Date.now()),
        source: SOURCE,
        source_url: url,
        dataset: 'amedas_daily',
        ...extra,
        error: '10分値が0件（ブロックが空）',
      });
      failures.push(`amedas_daily ${url}: 10分値が0件`);
      continue;
    }

    // "20260726235000" → "2026-07-26T23:50:00+09:00"（他データセットと表記を揃える）
    const lastKey = times[times.length - 1];
    const observedAt =
      `${lastKey.slice(0, 4)}-${lastKey.slice(4, 6)}-${lastKey.slice(6, 8)}` +
      `T${lastKey.slice(8, 10)}:${lastKey.slice(10, 12)}:${lastKey.slice(12, 14)}+09:00`;

    await appendRecord('amedas_daily', parts, {
      fetched_at: jstIso(Date.now()),
      source: SOURCE,
      source_url: url,
      dataset: 'amedas_daily',
      ...extra,
      observed_at: observedAt,
      record_count: times.length,
      data: res.data[lastKey],
    });
    appended++;
  }
  console.log(`amedas_daily: ${parts.iso} の ${appended} 地点を追記`);
}

// ---------------------------------------------------------------- main

async function main() {
  const mode = process.argv[2];
  if (mode !== 'hourly' && mode !== 'daily') {
    console.error('使い方: node scripts/collect.mjs <hourly|daily>');
    process.exit(2);
  }

  console.log(`[${jstIso(Date.now())}] mode=${mode}`);

  if (mode === 'hourly') {
    const state = await readState();
    await collectTyphoons(state);
    await collectWarnings(state);
    await collectAmedasSnapshot();
    await writeState(state);
  } else {
    await collectAmedasDaily();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} 件の取得に失敗しました（欠測として記録済み）:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1); // GitHub からの失敗通知メールを監視代わりにする
  }
  console.log('ok');
}

main().catch((err) => {
  console.error('想定外のエラー:', err);
  process.exit(1);
});
