import test from 'ava';
import nock from 'nock';
import { tmpdir } from 'os';
import { join } from 'path';
import mkdirp from 'mkdirp';
import { EventEmitter } from 'events';

import { Strategy, Unleash } from '../lib/unleash';

class EnvironmentStrategy extends Strategy {
    constructor() {
        super('EnvironmentStrategy');
    }

    isEnabled(parameters, context) {
        return parameters.environments.indexOf(context.environment) !== -1;
    }
}

let counter = 1;
const getUrl = () => `http://test2${counter++}.app/`;

function getRandomBackupPath() {
    const path = join(tmpdir(), `test-tmp-${Math.round(Math.random() * 100000)}`);
    mkdirp.sync(path);
    return path;
}

const defaultToggles = [
    {
        name: 'feature',
        enabled: true,
        strategies: [],
    },
    {
        name: 'f-context',
        enabled: true,
        strategies: [
            {
                name: 'EnvironmentStrategy',
                parameters: {
                    environments: 'prod',
                },
            },
        ],
    },
];

class FakeRepo extends EventEmitter {
    constructor() {
        super();
        this.data = {
            name: 'fake-feature',
            enabled: false,
            strategies: [],
        };
    }
    stop() {
        return;
    }
    getToggle() {
        return this.data;
    }
}

function mockNetwork(toggles = defaultToggles, url = getUrl()) {
    nock(url)
        .get('/client/features')
        .reply(200, { features: toggles });
    return url;
}

test('should error when missing url', t => {
    t.throws(() => new Unleash({}));
    t.throws(() => new Unleash({ url: false }));
    t.throws(() => new Unleash({ url: 'http://unleash.github.io', appName: false }));
});

test.cb('should handle old url', t => {
    const url = mockNetwork([]);

    const instance = new Unleash({
        appName: 'foo',
        refreshInterval: 0,
        metricsInterval: 0,
        disableMetrics: true,
        url: `${url}features`,
    });

    t.plan(1);
    instance.on('warn', e => {
        t.truthy(e);
        t.end();
    });

    instance.destroy();
});

test('should handle url without ending /', t => {
    const baseUrl = `${getUrl()}api`;

    mockNetwork([], baseUrl);

    const instance = new Unleash({
        appName: 'foo',
        refreshInterval: 0,
        metricsInterval: 0,
        disableMetrics: true,
        url: baseUrl,
    });

    t.true(`${baseUrl}/` === instance.repository.url);

    instance.destroy();
});

test('should re-emit error from repository, storage and metrics', t => {
    const url = mockNetwork([]);

    const instance = new Unleash({
        appName: 'foo',
        refreshInterval: 0,
        metricsInterval: 0,
        disableMetrics: true,
        url,
    });

    t.plan(3);
    instance.on('error', e => {
        t.truthy(e);
    });
    instance.repository.emit('error', new Error());
    instance.repository.storage.emit('error', new Error());
    instance.metrics.emit('error', new Error());

    instance.destroy();
});

test('should re-emit events from repository and metrics', t => {
    const url = mockNetwork();
    const instance = new Unleash({
        appName: 'foo',
        refreshInterval: 0,
        disableMetrics: true,
        url,
    });

    t.plan(5);
    instance.on('warn', e => t.truthy(e));
    instance.on('sent', e => t.truthy(e));
    instance.on('registered', e => t.truthy(e));
    instance.on('count', e => t.truthy(e));

    instance.repository.emit('warn', true);
    instance.metrics.emit('warn', true);
    instance.metrics.emit('sent', true);
    instance.metrics.emit('registered', true);
    instance.metrics.emit('count', true);

    instance.destroy();
});

test.cb('repository should surface error when invalid basePath', t => {
    const url = 'http://unleash-surface.app/';
    nock(url)
        .get('/client/features')
        .delay(100)
        .reply(200, { features: [] });
    const backupPath = join(tmpdir(), `test-tmp-${Math.round(Math.random() * 100000)}`);
    const instance = new Unleash({
        appName: 'foo',
        disableMetrics: true,
        refreshInterval: 0,
        url,
        backupPath,
    });

    instance.once('error', err => {
        t.truthy(err);
        t.true(err.code === 'ENOENT');

        instance.destroy();

        t.end();
    });
});

test('should allow request even before unleash is initialized', t => {
    const url = mockNetwork();
    const instance = new Unleash({
        appName: 'foo',
        disableMetrics: true,
        url,
        backupPath: getRandomBackupPath(),
    }).on('error', err => {
        throw err;
    });
    t.true(instance.isEnabled('unknown') === false);
    instance.destroy();
});

test('should consider known feature-toggle as active', t =>
    new Promise((resolve, reject) => {
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
        }).on('error', reject);

        instance.on('ready', () => {
            t.true(instance.isEnabled('feature') === true);
            instance.destroy();
            resolve();
        });
    }));

test('should consider unknown feature-toggle as disabled', t =>
    new Promise((resolve, reject) => {
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
        }).on('error', reject);

        instance.on('ready', () => {
            t.true(instance.isEnabled('unknown') === false);
            instance.destroy();
            resolve();
        });
    }));

test('should return fallback value until online', t =>
    new Promise((resolve, reject) => {
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
        }).on('error', reject);

        let warnCounter = 0;
        instance.on('warn', () => {
            warnCounter++;
        });

        t.true(instance.isEnabled('feature') === false);
        t.true(warnCounter === 1);
        t.true(instance.isEnabled('feature', {}, false) === false);
        t.true(instance.isEnabled('feature', {}, true) === true);
        t.true(warnCounter === 3);

        instance.on('ready', () => {
            t.true(instance.isEnabled('feature') === true);
            t.true(instance.isEnabled('feature', {}, false) === true);
            instance.destroy();
            resolve();
        });
    }));

test('should not throw when os.userInfo throws', t => {
    t.plan(0);

    return new Promise((resolve, reject) => {
        require('os').userInfo = () => {
            throw new Error('Test exception');
        };
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
        }).on('error', reject);

        instance.on('ready', () => {
            resolve();
        });
    });
});

test('should return known feature-toggle definition', t =>
    new Promise((resolve, reject) => {
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
        }).on('error', reject);

        instance.on('ready', () => {
            const toggle = instance.getFeatureToggleDefinition('feature');
            t.truthy(toggle);
            instance.destroy();
            resolve();
        });
    }));

test('should return feature-toggles', t =>
    new Promise((resolve, reject) => {
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
        }).on('error', reject);

        instance.on('ready', () => {
            const toggles = instance.getFeatureToggleDefinitions();
            t.deepEqual(toggles, defaultToggles);
            instance.destroy();
            resolve();
        });
    }));

test('returns undefined for unknown feature-toggle definition', t =>
    new Promise((resolve, reject) => {
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
        }).on('error', reject);

        instance.on('ready', () => {
            const toggle = instance.getFeatureToggleDefinition('unknown');
            t.falsy(toggle);
            instance.destroy();
            resolve();
        });
    }));

test('should use the injected repository', t =>
    new Promise((resolve, reject) => {
        const repo = new FakeRepo();
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
            repository: repo,
        }).on('error', reject);
        instance.on('ready', () => {
            t.false(instance.isEnabled('fake-feature'));
            instance.destroy();
            resolve();
        });
        repo.emit('ready');
    }));

test('should add static context fields', t =>
    new Promise((resolve, reject) => {
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
            environment: 'prod',
            strategies: [new EnvironmentStrategy()],
        }).on('error', reject);

        instance.on('ready', () => {
            t.true(instance.isEnabled('f-context') === true);
            instance.destroy();
            resolve();
        });
    }));

test('should local context should take precendence over static context fields', t =>
    new Promise((resolve, reject) => {
        const url = mockNetwork();
        const instance = new Unleash({
            appName: 'foo',
            disableMetrics: true,
            url,
            backupPath: getRandomBackupPath(),
            environment: 'prod',
            strategies: [new EnvironmentStrategy()],
        }).on('error', reject);

        instance.on('ready', () => {
            t.true(instance.isEnabled('f-context', { environment: 'dev' }) === false);
            instance.destroy();
            resolve();
        });
    }));
