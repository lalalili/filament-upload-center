# Changelog

`lalalili/filament-upload-center` 的所有重要變更都記錄於此。

## [1.0.0] - 2026-07-27

### Added

- 首個穩定版,遵循
  [SEMVER.md](https://github.com/lalalili/.github/blob/main/SEMVER.md)。
- **DOM 契約測試**。`createUploadCenter(root, options)` 會用 `querySelector`
  在 root 底下找五個 `data-upload-*` 子元素,而本套件的 `mount.blade.php`
  只渲染最外層容器,內層標記由各宿主自行提供 —— 任一邊改了屬性名稱,
  整合都會**靜默失效**。`tests/Unit/DomContractTest.php` 會從
  `resources/js/upload-center.js` 解析出實際查詢的選擇器,與 README 記載的
  清單比對,不一致就讓 CI 失敗。
- README 新增「DOM contract」章節,列出宿主必須提供的五個屬性。
- 掛上共用 CI(先前這個套件 **0 測試、0 CI**,卻已被 aitehub 與 eip 用在
  正式流程)。
