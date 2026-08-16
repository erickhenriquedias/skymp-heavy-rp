'use strict';

class WhitelistWorkflowError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'WhitelistWorkflowError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function workflowError(code, message, httpStatus) {
  return new WhitelistWorkflowError(code, message, httpStatus);
}

async function inTransaction(pool, operation) {
  const connection = await pool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;
    const result = await operation(connection);
    await connection.commit();
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function submitWhitelistApplication(pool, accountId, application) {
  return inTransaction(pool, async (connection) => {
    // A linha da conta e o mutex distribuido deste fluxo. Dois processos web
    // diferentes disputam o mesmo lock no InnoDB antes de verificar/inserir.
    const [accounts] = await connection.execute(
      'SELECT id, status FROM accounts WHERE id = ? FOR UPDATE',
      [accountId]
    );
    if (accounts.length === 0) {
      throw workflowError('ACCOUNT_NOT_FOUND', 'Conta não encontrada.', 404);
    }
    if (accounts[0].status !== 'active') {
      throw workflowError('ACCOUNT_INACTIVE', 'Esta conta não pode enviar uma candidatura.', 403);
    }

    const [existing] = await connection.execute(
      `SELECT id, status
         FROM whitelist_applications
        WHERE account_id = ? AND status IN ('pending', 'approved')
        ORDER BY id DESC
        LIMIT 1`,
      [accountId]
    );
    if (existing.length > 0) {
      throw workflowError(
        'ACTIVE_APPLICATION_EXISTS',
        'Você já possui uma aplicação pendente ou aprovada.',
        409
      );
    }

    const [characterResult] = await connection.execute(
      `INSERT INTO characters
         (account_id, first_name, last_name, biography, motivations, weaknesses,
          social_ties, needs_extra_review, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        accountId,
        application.first_name,
        application.last_name,
        application.biography,
        application.motivations,
        application.weaknesses,
        application.social_ties,
        application.needsExtraReview
      ]
    );
    const characterId = Number(characterResult.insertId);
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
      throw new Error('INSERT de personagem não retornou um id válido');
    }

    const [applicationResult] = await connection.execute(
      `INSERT INTO whitelist_applications (account_id, character_id, status)
       VALUES (?, ?, 'pending')`,
      [accountId, characterId]
    );

    return {
      applicationId: Number(applicationResult.insertId),
      characterId
    };
  });
}

const CHARACTER_STATUS_BY_REVIEW = Object.freeze({
  approved: 'approved',
  rejected: 'rejected',
  pending: 'pending'
});

async function reviewWhitelistApplication(pool, input) {
  return inTransaction(pool, async (connection) => {
    // Primeiro descobrimos a conta sem lock; depois adquirimos os locks sempre
    // na ordem account -> application -> character, igual ao fluxo de envio.
    const [applicationOwner] = await connection.execute(
      'SELECT account_id FROM whitelist_applications WHERE id = ?',
      [input.applicationId]
    );
    if (applicationOwner.length === 0) {
      throw workflowError('APPLICATION_NOT_FOUND', 'Aplicação não encontrada.', 404);
    }

    const accountId = Number(applicationOwner[0].account_id);
    const [accounts] = await connection.execute(
      'SELECT id FROM accounts WHERE id = ? FOR UPDATE',
      [accountId]
    );
    if (accounts.length === 0) {
      throw workflowError('ACCOUNT_NOT_FOUND', 'Conta da aplicação não encontrada.', 409);
    }

    const [applications] = await connection.execute(
      `SELECT id, account_id, character_id, status, approval_source
         FROM whitelist_applications
        WHERE id = ? AND account_id = ?
        FOR UPDATE`,
      [input.applicationId, accountId]
    );
    if (applications.length === 0) {
      throw workflowError('APPLICATION_CHANGED', 'A aplicação mudou durante a revisão.', 409);
    }

    const application = applications[0];
    if (application.status !== input.expectedStatus) {
      throw workflowError(
        'APPLICATION_STATUS_CHANGED',
        'Outro revisor alterou esta aplicação. Atualize a fila antes de tentar novamente.',
        409
      );
    }
    const characterId = Number(application.character_id);
    if (!Number.isSafeInteger(characterId) || characterId <= 0) {
      throw workflowError(
        'APPLICATION_WITHOUT_CHARACTER',
        'Aplicação antiga sem personagem vinculado; corrija o vínculo antes de revisar.',
        409
      );
    }

    const [characters] = await connection.execute(
      'SELECT id, status FROM characters WHERE id = ? AND account_id = ? FOR UPDATE',
      [characterId, accountId]
    );
    if (characters.length === 0) {
      throw workflowError(
        'CHARACTER_NOT_FOUND',
        'O personagem vinculado à aplicação não existe.',
        409
      );
    }
    if (characters[0].status === 'retired') {
      throw workflowError(
        'CHARACTER_RETIRED',
        'Personagem aposentado não pode ser reativado pela whitelist.',
        409
      );
    }

    const desiredCharacterStatus = CHARACTER_STATUS_BY_REVIEW[input.status];
    if (!desiredCharacterStatus) {
      throw workflowError('INVALID_STATUS', 'Status inválido.', 400);
    }

    const desiredApprovalSource = input.status === 'approved' ? 'staff' : null;
    const stateChanged = application.status !== input.status
      || (application.approval_source || null) !== desiredApprovalSource
      || characters[0].status !== desiredCharacterStatus;

    if (input.reviewerNotes === undefined) {
      await connection.execute(
        `UPDATE whitelist_applications
            SET status = ?, approval_source = ?, reviewed_by = ?, reviewed_at = NOW()
          WHERE id = ?`,
        [input.status, desiredApprovalSource, input.reviewedBy, input.applicationId]
      );
    } else {
      await connection.execute(
        `UPDATE whitelist_applications
            SET status = ?, approval_source = ?, reviewer_notes = ?, reviewed_by = ?, reviewed_at = NOW()
          WHERE id = ?`,
        [
          input.status,
          desiredApprovalSource,
          input.reviewerNotes,
          input.reviewedBy,
          input.applicationId
        ]
      );
    }

    if (input.extraReviewNotes !== undefined) {
      await connection.execute(
        'UPDATE characters SET extra_review_notes = ? WHERE id = ? AND account_id = ?',
        [input.extraReviewNotes, characterId, accountId]
      );
    }

    if (characters[0].status !== desiredCharacterStatus) {
      const [statusResult] = await connection.execute(
        `UPDATE characters
            SET status = ?
          WHERE id = ? AND account_id = ? AND status <> 'retired'`,
        [desiredCharacterStatus, characterId, accountId]
      );
      if (statusResult.affectedRows !== 1) {
        throw workflowError(
          'CHARACTER_CHANGED',
          'O personagem mudou durante a revisão; tente novamente.',
          409
        );
      }
    }

    if (stateChanged) {
      const auditAction = input.status === 'approved' ? 'whitelist:approve'
        : input.status === 'rejected' ? 'whitelist:reject'
          : 'whitelist:reset';
      await connection.execute(
        `INSERT INTO audit_logs
           (action, actor_account_id, target_account_id, details)
         VALUES (?, ?, ?, ?)`,
        [auditAction, input.reviewerAccountId, accountId, input.reviewerNotes ?? null]
      );
    }

    const [identities] = await connection.execute(
      'SELECT discord_id FROM discord_identities WHERE account_id = ? LIMIT 1',
      [accountId]
    );

    return {
      accountId,
      characterId,
      discordId: identities[0]?.discord_id || null,
      stateChanged
    };
  });
}

module.exports = {
  WhitelistWorkflowError,
  submitWhitelistApplication,
  reviewWhitelistApplication
};
