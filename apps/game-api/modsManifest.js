'use strict';

// Compatibilidade para os consumidores existentes. A implementação vive no
// pacote compartilhado porque game-api e gamemode precisam verificar exatamente
// o mesmo envelope de paridade, sem duas cópias do contrato criptográfico.
module.exports = require('../../skymp/packages/mods-manifest-loader');
