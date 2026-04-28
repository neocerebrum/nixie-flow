<?php
declare(strict_types=1);

require __DIR__ . '/app/bootstrap.php';

$router = new App\Router();

// Public
$router->get('/',         [App\Controllers\HomeController::class,    'index']);
$router->get('/login',    [App\Controllers\AuthController::class,    'loginForm']);
$router->post('/login',   [App\Controllers\AuthController::class,    'login']);
$router->post('/logout',  [App\Controllers\AuthController::class,    'logout']);

// Authenticated user
$router->get('/dashboard',     [App\Controllers\DashboardController::class, 'index']);
$router->get('/editor/{slug}', [App\Controllers\EditorController::class,    'show']);
$router->get('/profile',                  [App\Controllers\ProfileController::class, 'show']);
$router->post('/profile',                 [App\Controllers\ProfileController::class, 'save']);
$router->get('/profile/tokens',           [App\Controllers\ProfileController::class, 'tokens']);
$router->post('/profile/tokens',          [App\Controllers\ProfileController::class, 'createToken']);
$router->post('/profile/tokens/revoke',   [App\Controllers\ProfileController::class, 'revokeToken']);

// Admin
$router->get('/admin/users',           [App\Controllers\Admin\UserController::class, 'index']);
$router->get('/admin/users/new',       [App\Controllers\Admin\UserController::class, 'newForm']);
$router->post('/admin/users',          [App\Controllers\Admin\UserController::class, 'create']);
$router->get('/admin/users/{id}',      [App\Controllers\Admin\UserController::class, 'editForm']);
$router->post('/admin/users/{id}',     [App\Controllers\Admin\UserController::class, 'update']);
$router->post('/admin/users/{id}/disable', [App\Controllers\Admin\UserController::class, 'disable']);
$router->post('/admin/users/{id}/restore', [App\Controllers\Admin\UserController::class, 'restore']);

// API
$router->get('/api/csrf',                       [App\Controllers\Api\CsrfController::class,    'token']);
$router->get('/api/diagrams',                   [App\Controllers\Api\DiagramController::class, 'index']);
$router->post('/api/diagrams',                  [App\Controllers\Api\DiagramController::class, 'create']);
$router->get('/api/diagrams/{slug}',            [App\Controllers\Api\DiagramController::class, 'show']);
$router->post('/api/diagrams/{slug}',           [App\Controllers\Api\DiagramController::class, 'save']);
$router->patch('/api/diagrams/{slug}/draft',    [App\Controllers\Api\DiagramController::class, 'saveDraft']);
$router->patch('/api/diagrams/{slug}',          [App\Controllers\Api\DiagramController::class, 'patch']);
$router->delete('/api/diagrams/{slug}',         [App\Controllers\Api\DiagramController::class, 'delete']);
$router->get('/api/diagrams/{slug}/history',    [App\Controllers\Api\DiagramController::class, 'history']);
$router->post('/api/diagrams/{slug}/undo',      [App\Controllers\Api\DiagramController::class, 'undo']);
$router->post('/api/diagrams/{slug}/redo',      [App\Controllers\Api\DiagramController::class, 'redo']);
$router->post('/api/diagrams/{slug}/checkout',  [App\Controllers\Api\DiagramController::class, 'checkout']);
$router->post('/api/diagrams/{slug}/restore',   [App\Controllers\Api\DiagramController::class, 'restore']);

// Phase 3: lock + edit-requests + sharing
$router->post('/api/diagrams/{slug}/lock',           [App\Controllers\Api\LockController::class, 'acquire']);
$router->post('/api/diagrams/{slug}/lock/heartbeat', [App\Controllers\Api\LockController::class, 'heartbeat']);
$router->delete('/api/diagrams/{slug}/lock',         [App\Controllers\Api\LockController::class, 'release']);

$router->post('/api/diagrams/{slug}/edit-requests',                  [App\Controllers\Api\EditRequestController::class, 'create']);
$router->get('/api/diagrams/{slug}/edit-requests',                   [App\Controllers\Api\EditRequestController::class, 'listForDiagram']);
$router->get('/api/diagrams/{slug}/edit-requests/mine',              [App\Controllers\Api\EditRequestController::class, 'mine']);
$router->post('/api/diagrams/{slug}/edit-requests/{id}/accept',      [App\Controllers\Api\EditRequestController::class, 'accept']);
$router->post('/api/diagrams/{slug}/edit-requests/{id}/decline',     [App\Controllers\Api\EditRequestController::class, 'decline']);
$router->delete('/api/diagrams/{slug}/edit-requests/{id}',           [App\Controllers\Api\EditRequestController::class, 'cancel']);

$router->get('/api/diagrams/{slug}/shares',              [App\Controllers\Api\ShareController::class, 'index']);
$router->post('/api/diagrams/{slug}/shares',             [App\Controllers\Api\ShareController::class, 'create']);
$router->delete('/api/diagrams/{slug}/shares/{user_id}', [App\Controllers\Api\ShareController::class, 'delete']);

// MCP HTTP endpoint (Bearer-token authenticated, no CSRF; JSON-RPC 2.0)
$router->post('/mcp',     [App\Controllers\Api\McpController::class, 'handle']);
$router->add('OPTIONS', '/mcp', [App\Controllers\Api\McpController::class, 'handle']);

$router->dispatch();
