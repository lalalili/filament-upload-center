<?php

namespace Lalalili\FilamentUploadCenter\Tests;

use Lalalili\FilamentUploadCenter\FilamentUploadCenterServiceProvider;
use Lalalili\PackageTestingSupport\PackageTestCase;

abstract class TestCase extends PackageTestCase
{
    /**
     * @return list<class-string>
     */
    protected function getPackageProviders($app): array
    {
        return [FilamentUploadCenterServiceProvider::class];
    }
}
