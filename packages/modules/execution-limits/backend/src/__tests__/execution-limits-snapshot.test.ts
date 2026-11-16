import { DEFAULT_EXECUTION_LIMIT_SETTINGS, type ExecutionLimitSettings } from '@n8n/api-types';
import { mockLogger } from '@n8n/backend-test-utils';
import type { Publisher } from '@n8n/backend-services';
import { PubSubMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { mock } from 'vitest-mock-extended';

import type { ExecutionLimitSettingsStore } from '../execution-limit-settings.store';
import { ExecutionLimitsSnapshot } from '../execution-limits-snapshot';
import type { ProjectExecutionLimitRepository } from '../project-execution-limit.repository';

const SETTINGS: ExecutionLimitSettings = {
	periodUnit: 'week',
	instanceMaxExecutions: 1000,
	defaultProjectMaxExecutions: null,
};

describe('ExecutionLimitsSnapshot', () => {
	const settingsStore = mock<ExecutionLimitSettingsStore>();
	const projectLimitRepository = mock<ProjectExecutionLimitRepository>();
	const publisher = mock<Publisher>();
	let snapshot: ExecutionLimitsSnapshot;

	beforeEach(() => {
		vi.resetAllMocks();
		settingsStore.read.mockResolvedValue(SETTINGS);
		projectLimitRepository.findAll.mockResolvedValue([{ projectId: 'limited', maxExecutions: 50 }]);
		publisher.publishCommand.mockResolvedValue();
		snapshot = new ExecutionLimitsSnapshot(
			settingsStore,
			projectLimitRepository,
			publisher,
			mockLogger(),
		);
	});

	it('has nothing to read before the first load', () => {
		expect(snapshot.read('limited')).toBeNull();
	});

	it('reads the settings and the limit of a project from memory after the start', async () => {
		await snapshot.start();
		vi.clearAllMocks();

		expect(snapshot.read('limited')).toEqual({ settings: SETTINGS, projectMaxExecutions: 50 });
		expect(snapshot.read('other')).toEqual({ settings: SETTINGS, projectMaxExecutions: null });
		expect(settingsStore.read).not.toHaveBeenCalled();
		expect(projectLimitRepository.findAll).not.toHaveBeenCalled();
	});

	it('starts with nothing loaded when the first load fails, and loads on the next reload', async () => {
		settingsStore.read.mockRejectedValueOnce(new Error('database is down'));

		await snapshot.start();
		expect(snapshot.read('limited')).toBeNull();

		await snapshot.handleReloadRequest();
		expect(snapshot.read('limited')).toEqual({ settings: SETTINGS, projectMaxExecutions: 50 });
	});

	it('keeps the loaded limits when a reload fails', async () => {
		await snapshot.start();
		projectLimitRepository.findAll.mockRejectedValueOnce(new Error('database is down'));

		await snapshot.handleReloadRequest();

		expect(snapshot.read('limited')).toEqual({ settings: SETTINGS, projectMaxExecutions: 50 });
	});

	it('loads the changed limits on a reload request', async () => {
		await snapshot.start();
		settingsStore.read.mockResolvedValue(DEFAULT_EXECUTION_LIMIT_SETTINGS);
		projectLimitRepository.findAll.mockResolvedValue([]);

		await snapshot.handleReloadRequest();

		expect(snapshot.read('limited')).toEqual({
			settings: DEFAULT_EXECUTION_LIMIT_SETTINGS,
			projectMaxExecutions: null,
		});
	});

	describe('refreshAfterWrite', () => {
		it('reloads this process and tells the other processes to reload', async () => {
			await snapshot.refreshAfterWrite();

			expect(snapshot.read('limited')).toEqual({ settings: SETTINGS, projectMaxExecutions: 50 });
			expect(publisher.publishCommand).toHaveBeenCalledExactlyOnceWith({
				command: 'reload-execution-limits',
			});
		});

		it('resolves when the publish fails, because the write already committed', async () => {
			publisher.publishCommand.mockRejectedValue(new Error('redis is down'));

			await expect(snapshot.refreshAfterWrite()).resolves.toBeUndefined();
		});
	});

	it.each(['reload-execution-limits', 'pubsub-reconnected'])(
		'registers handleReloadRequest for %s',
		(eventName) => {
			const handlers = Container.get(PubSubMetadata)
				.getHandlers()
				.filter(
					(handler) =>
						handler.eventName === eventName &&
						handler.eventHandlerClass.name === 'ExecutionLimitsSnapshot',
				);

			expect(handlers.map(({ methodName }) => methodName)).toEqual(['handleReloadRequest']);
		},
	);
});
