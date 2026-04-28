<?php
declare(strict_types=1);

namespace App\Exceptions;

final class RevisionConflict extends \RuntimeException
{
    public function __construct(public readonly ?int $currentRevisionId)
    {
        parent::__construct('Revision conflict');
    }
}
