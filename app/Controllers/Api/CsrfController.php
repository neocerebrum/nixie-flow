<?php
declare(strict_types=1);

namespace App\Controllers\Api;

use App\Auth;
use App\Csrf;
use App\Response;

final class CsrfController
{
    public function token(array $args): never
    {
        Auth::requireLoginApi();
        Response::json(['token' => Csrf::token()]);
    }
}
