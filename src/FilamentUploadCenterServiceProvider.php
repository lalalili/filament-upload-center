<?php

namespace Lalalili\FilamentUploadCenter;

use Illuminate\Support\ServiceProvider;

class FilamentUploadCenterServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $this->loadViewsFrom(__DIR__.'/../resources/views', 'filament-upload-center');
    }
}
