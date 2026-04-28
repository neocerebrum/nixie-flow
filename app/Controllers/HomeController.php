<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Response;

final class HomeController
{
    public function index(array $args): never
    {
        Response::redirect(Auth::isLoggedIn() ? '/dashboard' : '/login');
    }
}
