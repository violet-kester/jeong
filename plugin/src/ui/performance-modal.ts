import { App, Modal } from 'obsidian';
import { t } from '../i18n';
import type { Metrics, MetricRecord } from '../metrics/metrics';
import { shortName } from './record-modal';

// A summary of everything in the local metrics log: how fast each model loads and
// transcribes, how accurate it was on the test script, and any errors.
export class PerformanceModal extends Modal {
	constructor(
		app: App,
		private metrics: Metrics,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass('jeong', 'jeong-performance');
		this.setTitle(t('perf.title'));
		const records = await this.metrics.readAll();
		const { contentEl } = this;

		if (!records.length) {
			contentEl.createEl('p', { text: t('perf.empty') });
			return;
		}

		const rows = new Map<string, { kind: string; loads: number[]; speeds: number[]; wers: number[] }>();
		const row = (kind: string, model: string) => {
			const key = `${kind}|${model}`;
			if (!rows.has(key)) rows.set(key, { kind, loads: [], speeds: [], wers: [] });
			return rows.get(key)!;
		};
		let errors = 0;
		let recordings = 0;
		let audioMinutes = 0;
		for (const record of records) {
			if (record.event === 'model_load') row(record.kind, record.model).loads.push(record.loadMs);
			if (record.event === 'transcribe') row(record.kind, record.model).speeds.push(record.speed);
			if (record.event === 'quality') row(record.kind, record.model).wers.push(record.wer);
			if (record.event === 'error') errors++;
			if (record.event === 'recording') {
				recordings++;
				audioMinutes += record.durationMs / 60_000;
			}
		}

		const table = contentEl.createEl('table', { cls: 'jeong-perf-table' });
		const head = table.createEl('tr');
		for (const label of ['perf.model', 'perf.use', 'perf.load', 'perf.speed', 'perf.wordsWrong'] as const) {
			head.createEl('th', { text: t(label) });
		}
		for (const [key, stats] of rows) {
			const tr = table.createEl('tr');
			tr.createEl('td', { text: shortName(key.split('|')[1] ?? '') });
			tr.createEl('td', { text: t(stats.kind === 'live' ? 'perf.live' : 'perf.final') });
			tr.createEl('td', { text: stats.loads.length ? `${(median(stats.loads) / 1000).toFixed(1)} s` : '—' });
			tr.createEl('td', { text: stats.speeds.length ? `${median(stats.speeds).toFixed(1)}×` : '—' });
			tr.createEl('td', { text: stats.wers.length ? `${Math.round(median(stats.wers) * 100)}%` : '—' });
		}

		contentEl.createEl('p', {
			cls: 'jeong-perf-summary',
			text: `${recordings} ${t('perf.recordings')} · ${audioMinutes.toFixed(1)} ${t('perf.minutes')} · ${errors} ${t('perf.errors')} · ${t('perf.since')} ${firstDay(records)}`,
		});
		contentEl.createEl('p', { cls: 'jeong-perf-note', text: `${t('perf.where')} ${this.metrics.directory}` });
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function firstDay(records: MetricRecord[]): string {
	return records[0]?.ts.slice(0, 10) ?? '';
}
