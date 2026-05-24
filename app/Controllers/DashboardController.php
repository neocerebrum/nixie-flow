<?php
declare(strict_types=1);

namespace App\Controllers;

use App\Auth;
use App\Csrf;
use App\Models\Diagram;
use App\View;

final class DashboardController
{
    public function index(array $args): never
    {
        $user = Auth::requireLogin();
        $rows = Diagram::listAccessibleForUser((int) $user['id']);

        $userId = (int) $user['id'];
        $owned = [];
        $shared = [];
        foreach ($rows as $d) {
            if ((int) $d['owner_id'] === $userId) {
                $owned[] = $d;
            } else {
                $shared[] = $d;
            }
        }

        View::render('dashboard', [
            'user'           => $user,
            'diagrams'       => $owned,
            'sharedDiagrams' => $shared,
            'csrfToken'      => Csrf::token(),
        ], ['title' => __('dashboard.title'), 'active' => 'dashboard']);
    }
}
