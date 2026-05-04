<?php
declare(strict_types=1);

namespace App\Exceptions;

final class QuotaExceeded extends \RuntimeException
{
    public const KIND_DIAGRAMS  = 'diagrams_per_user';
    public const KIND_REVISIONS = 'revisions_per_diagram';
    public const KIND_BYTES     = 'bytes_per_user';

    public function __construct(
        public readonly string $kind,
        public readonly int $limit,
        public readonly int $current,
        string $message
    ) {
        parent::__construct($message);
    }
}
