/**
 * @license Copyright 2019 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import {jest} from '@jest/globals';

jest.useFakeTimers();

import Driver from '../../../gather/driver.js';
import Connection from '../../../gather/connections/connection.js';
import SourceMaps from '../../../gather/gatherers/source-maps.js';
import {createMockSendCommandFn, createMockOnFn} from '../mock-commands.js';
import {flushAllTimersAndMicrotasks, fnAny} from '../../test-utils.js';

const mapJson = JSON.stringify({
  version: 3,
  file: 'out.js',
  sourceRoot: '',
  sources: ['foo.js', 'bar.js'],
  names: ['src', 'maps', 'are', 'fun'],
  mappings: 'AAgBC,SAAQ,CAAEA',
});

describe('SourceMaps gatherer', () => {
  /**
   * `scriptParsedEvent` mocks the `sourceMapURL` and `url` seen from the protocol.
   * `map` mocks the (JSON) of the source maps that `Runtime.evaluate` returns.
   * `resolvedSourceMapUrl` is used to assert that the SourceMaps gatherer is using the expected
   *                        url to fetch the source map.
   * `fetchError` mocks an error that happens in the page. Only fetch error message make sense.
   * @param {Array<{scriptParsedEvent: LH.Crdp.Debugger.ScriptParsedEvent, map: string, status?: number, resolvedSourceMapUrl?: string, fetchError: string}>} mapsAndEvents
   * @return {Promise<LH.Artifacts['SourceMaps']>}
   */
  async function runSourceMaps(mapsAndEvents) {
    // pre-condition: should only define map or fetchError, not both.
    for (const {map, fetchError} of mapsAndEvents) {
      if (map && fetchError) {
        throw new Error('should only define map or fetchError, not both.');
      }
    }

    const onMock = createMockOnFn();
    const sendCommandMock = createMockSendCommandFn()
      .mockResponse('Debugger.enable', {})
      .mockResponse('Debugger.disable', {})
      .mockResponse('Network.enable', {});
    const fetchMock = fnAny();

    for (const mapAndEvents of mapsAndEvents) {
      const {
        scriptParsedEvent,
        map,
        status = null,
        resolvedSourceMapUrl,
        fetchError,
      } = mapAndEvents;
      onMock.mockEvent('protocolevent', {
        method: 'Debugger.scriptParsed',
        params: scriptParsedEvent,
      });

      if (scriptParsedEvent.sourceMapURL.startsWith('data:')) {
        // Only the source maps that need to be fetched use the `fetchMock` code path.
        continue;
      }

      fetchMock.mockImplementationOnce(async (sourceMapUrl) => {
        // Check that the source map url was resolved correctly.
        if (resolvedSourceMapUrl) {
          expect(sourceMapUrl).toBe(resolvedSourceMapUrl);
        }

        if (fetchError) {
          throw new Error(fetchError);
        }

        return {content: map, status};
      });
    }
    const connectionStub = new Connection();
    connectionStub.sendCommand = sendCommandMock;
    connectionStub.on = onMock;

    const driver = new Driver(connectionStub);
    driver.fetcher.fetchResource = fetchMock;

    const sourceMaps = new SourceMaps();

    await sourceMaps.startInstrumentation({driver});
    await sourceMaps.startSensitiveInstrumentation({driver});

    // Needed for protocol events to emit.
    await flushAllTimersAndMicrotasks(1);

    await sourceMaps.stopSensitiveInstrumentation({driver});
    await sourceMaps.stopInstrumentation({driver});

    return sourceMaps.getArtifact({driver});
  }

  function makeJsonDataUrl(data) {
    return 'data:application/json;charset=utf-8;base64,' + Buffer.from(data).toString('base64');
  }

  it('ignores script with no source map url', async () => {
    const artifact = await runSourceMaps([
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/script.js',
          sourceMapURL: '',
        },
        map: null,
      },
    ]);
    expect(artifact).toEqual([]);
  });

  it('fetches map for script with source map url', async () => {
    const mapsAndEvents = [
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/bundle.js',
          sourceMapURL: 'http://www.example.com/bundle.js.map',
        },
        map: mapJson,
        resolvedSourceMapUrl: 'http://www.example.com/bundle.js.map',
      },
    ];
    const artifact = await runSourceMaps(mapsAndEvents);
    expect(artifact).toEqual([
      {
        scriptUrl: mapsAndEvents[0].scriptParsedEvent.url,
        sourceMapUrl: mapsAndEvents[0].scriptParsedEvent.sourceMapURL,
        map: JSON.parse(mapsAndEvents[0].map),
      },
    ]);
  });

  it('fetches map for script with relative source map url', async () => {
    const mapsAndEvents = [
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/path/bundle.js',
          sourceMapURL: 'bundle.js.map',
        },
        map: mapJson,
        resolvedSourceMapUrl: 'http://www.example.com/path/bundle.js.map',
      },
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/path/bundle.js',
          sourceMapURL: '../bundle.js.map',
        },
        map: mapJson,
        resolvedSourceMapUrl: 'http://www.example.com/bundle.js.map',
      },
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/path/bundle.js',
          sourceMapURL: 'http://www.example-2.com/path/bundle.js',
        },
        map: mapJson,
        resolvedSourceMapUrl: 'http://www.example-2.com/path/bundle.js',
      },
    ];
    const artifacts = await runSourceMaps(mapsAndEvents);
    expect(artifacts).toEqual([
      {
        scriptUrl: mapsAndEvents[0].scriptParsedEvent.url,
        sourceMapUrl: 'http://www.example.com/path/bundle.js.map',
        map: JSON.parse(mapsAndEvents[0].map),
      },
      {
        scriptUrl: mapsAndEvents[1].scriptParsedEvent.url,
        sourceMapUrl: 'http://www.example.com/bundle.js.map',
        map: JSON.parse(mapsAndEvents[1].map),
      },
      {
        scriptUrl: mapsAndEvents[2].scriptParsedEvent.url,
        sourceMapUrl: mapsAndEvents[2].scriptParsedEvent.sourceMapURL,
        map: JSON.parse(mapsAndEvents[2].map),
      },
    ]);
  });

  it('throws an error message when fetching map returns bad status code', async () => {
    const mapsAndEvents = [
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/bundle.js',
          sourceMapURL: 'http://www.example.com/bundle.js.map',
        },
        status: 404,
        map: null,
      },
    ];
    const artifact = await runSourceMaps(mapsAndEvents);
    expect(artifact).toEqual([
      {
        scriptUrl: mapsAndEvents[0].scriptParsedEvent.url,
        sourceMapUrl: mapsAndEvents[0].scriptParsedEvent.sourceMapURL,
        errorMessage: 'Error: Failed fetching source map (404)',
        map: undefined,
      },
    ]);
  });

  it('generates an error message when fetching map fails', async () => {
    const mapsAndEvents = [
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/bundle.js',
          sourceMapURL: 'http://www.example.com/bundle.js.map',
        },
        fetchError: 'Failed fetching source map',
      },
    ];
    const artifact = await runSourceMaps(mapsAndEvents);
    expect(artifact).toEqual([
      {
        scriptUrl: mapsAndEvents[0].scriptParsedEvent.url,
        sourceMapUrl: mapsAndEvents[0].scriptParsedEvent.sourceMapURL,
        errorMessage: 'Error: Failed fetching source map',
        map: undefined,
      },
    ]);
  });

  it('generates an error message when map url cannot be resolved', async () => {
    const mapsAndEvents = [
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/bundle.js',
          sourceMapURL: 'http://',
        },
      },
    ];
    const artifact = await runSourceMaps(mapsAndEvents);
    expect(artifact).toEqual([
      {
        scriptUrl: mapsAndEvents[0].scriptParsedEvent.url,
        sourceMapUrl: undefined,
        errorMessage: 'Could not resolve map url: http://',
        map: undefined,
      },
    ]);
  });

  it('generates an error message when parsing map fails', async () => {
    const mapsAndEvents = [
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/bundle.js',
          sourceMapURL: 'http://www.example.com/bundle.js.map',
        },
        map: '{{}',
      },
      {
        scriptParsedEvent: {
          url: 'http://www.example.com/bundle-2.js',
          sourceMapURL: makeJsonDataUrl('{};'),
        },
      },
    ];
    const artifact = await runSourceMaps(mapsAndEvents);
    expect(artifact).toEqual([
      {
        scriptUrl: mapsAndEvents[0].scriptParsedEvent.url,
        sourceMapUrl: mapsAndEvents[0].scriptParsedEvent.sourceMapURL,
        errorMessage: 'SyntaxError: Unexpected token { in JSON at position 1',
        map: undefined,
      },
      {
        scriptUrl: mapsAndEvents[1].scriptParsedEvent.url,
        sourceMapUrl: undefined,
        errorMessage: 'SyntaxError: Unexpected token ; in JSON at position 2',
        map: undefined,
      },
    ]);
  });
});
