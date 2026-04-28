<?php
declare(strict_types=1);

namespace App;

final class Router
{
    /** @var array<int, array{method:string, regex:string, params:array<int,string>, handler:array{0:class-string,1:string}}> */
    private array $routes = [];

    public function get(string $path, array $handler): void    { $this->add('GET', $path, $handler); }
    public function post(string $path, array $handler): void   { $this->add('POST', $path, $handler); }
    public function put(string $path, array $handler): void    { $this->add('PUT', $path, $handler); }
    public function patch(string $path, array $handler): void  { $this->add('PATCH', $path, $handler); }
    public function delete(string $path, array $handler): void { $this->add('DELETE', $path, $handler); }

    public function add(string $method, string $path, array $handler): void
    {
        $params = [];
        $regex = preg_replace_callback(
            '#\{([a-zA-Z_][a-zA-Z0-9_]*)\}#',
            function ($m) use (&$params) {
                $params[] = $m[1];
                return '([^/]+)';
            },
            $path
        );
        $this->routes[] = [
            'method'  => strtoupper($method),
            'regex'   => '#^' . $regex . '$#',
            'params'  => $params,
            'handler' => $handler,
        ];
    }

    public function dispatch(): void
    {
        $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';

        foreach ($this->routes as $route) {
            if ($route['method'] !== $method) {
                continue;
            }
            if (preg_match($route['regex'], $uri, $m)) {
                array_shift($m);
                [$class, $methodName] = $route['handler'];
                $controller = new $class();
                $args = [];
                foreach ($route['params'] as $i => $name) {
                    $args[$name] = $m[$i] ?? null;
                }
                $controller->$methodName($args);
                return;
            }
        }

        Response::notFound("No route for $method $uri");
    }
}
