<?php

/**
 * 這個套件的核心風險不在 PHP,而在 JS 與宿主標記之間的 DOM 契約。
 *
 * `createUploadCenter(root, options)` 會在 root 底下用 querySelector 找
 * 五個 data 屬性。套件本身的 mount.blade.php 只渲染最外層容器,內層標記
 * 由各宿主(aitehub、eip)自行提供 —— 任何一邊改了屬性名稱,整合都會靜默失效
 * 且沒有任何測試會發現。
 *
 * 以下測試把契約釘在程式碼裡:JS 實際查詢的選擇器,必須與 README 記載、
 * 宿主據以實作的清單完全一致。
 */

/**
 * `createUploadCenter` 在 root 底下尋找的子元素。
 * 這份清單同時記載於 README,宿主的標記必須提供這些屬性。
 */
const EXPECTED_SELECTORS = [
    'data-upload-input',
    'data-upload-dropzone',
    'data-upload-list',
    'data-upload-count',
    'data-upload-notifications',
];

function uploadCenterJs(): string
{
    $path = __DIR__.'/../../resources/js/upload-center.js';

    expect($path)->toBeFile();

    return (string) file_get_contents($path);
}

it('ships the javascript entrypoint declared in package.json', function () {
    $manifest = json_decode(
        (string) file_get_contents(__DIR__.'/../../package.json'),
        true,
        flags: JSON_THROW_ON_ERROR,
    );

    $entry = $manifest['exports']['.'];

    expect($entry)->toBe('./resources/js/upload-center.js')
        ->and(__DIR__.'/../../'.$entry)->toBeFile();
});

it('exposes createUploadCenter as the public entrypoint', function () {
    expect(uploadCenterJs())->toContain('export function createUploadCenter(root, options)');
});

it('queries exactly the documented dom contract', function () {
    $js = uploadCenterJs();

    preg_match_all('/root\.querySelector\(\'\[([a-z-]+)\]\'\)/', $js, $matches);

    expect($matches[1])->not->toBeEmpty()
        ->and(array_values(array_unique($matches[1])))
        ->toEqualCanonicalizing(EXPECTED_SELECTORS);
});

it('documents every selector of the dom contract in the readme', function () {
    $readme = (string) file_get_contents(__DIR__.'/../../README.md');

    foreach (EXPECTED_SELECTORS as $selector) {
        expect($readme)->toContain($selector);
    }
});

it('renders the mount view with the attribute the javascript hooks onto', function () {
    // mount.blade.php 是 component 樣式的 view,一定要有 $attributes
    $html = view('filament-upload-center::mount', [
        'attributes' => new Illuminate\View\ComponentAttributeBag,
    ])->render();

    expect($html)->toContain('data-filament-upload-center');
});

it('lets hosts merge their own attributes onto the mount element', function () {
    $html = view('filament-upload-center::mount', [
        'attributes' => new Illuminate\View\ComponentAttributeBag(['id' => 'media-uploads']),
    ])->render();

    expect($html)->toContain('id="media-uploads"')
        ->and($html)->toContain('data-filament-upload-center');
});
