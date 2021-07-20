// Copyright 2019 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

(async function() {
  TestRunner.addResult('Tests that exporting works.\n');
  await TestRunner.navigatePromise('resources/lighthouse-basic.html');

  await TestRunner.loadTestModule('lighthouse_test_runner');
  await TestRunner.showPanel('lighthouse');

  LighthouseTestRunner.getRunButton().click();
  await LighthouseTestRunner.waitForResults();

  const resultsElement = LighthouseTestRunner.getResultsElement();
  const toolsMenu = resultsElement.querySelector('.lh-tools__dropdown');

  function waitForSave() {
    return new Promise(resolve => {
      TestRunner.addSniffer(Workspace.FileManager.prototype, 'save',
        (filename, content) => resolve(content));
    });
  }
  async function testExportJson() {
    const reportJsonPromise = waitForSave();
    toolsMenu.querySelector('a[data-action="save-json"').click();
    const reportJson = await reportJsonPromise;
    const lhr = JSON.parse(reportJson);
    TestRunner.addResult(`\n# of audits (json): ${Object.keys(lhr.audits).length}`);
  }

  TestRunner.addResult('\n++++++++ testExportJson');
  await testExportJson();

  TestRunner.completeTest();
})();
