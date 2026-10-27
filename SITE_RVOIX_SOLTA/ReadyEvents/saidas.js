const fs = require('fs');
const path = require('path');

module.exports = {
    run: (client) => {
        console.log("[READY] Script de Logs de Saída ativado!");

        client.on("guildMemberRemove", async (member) => {
            try {
                // Caminho para o arquivo de configuração na pasta databases
                const configPath = path.join(__dirname, "../database/configuracaoready.json");
                
                if (!fs.existsSync(configPath)) {
                    return console.warn("[READY ERRO] Arquivo configuracaoready.json não encontrado para saídas!");
                }

                // Lê o arquivo JSON
                const configRaw = fs.readFileSync(configPath, 'utf8');
                const config = JSON.parse(configRaw);
                
                // Pega o ID do canal de saídas (adicione essa chave no seu JSON)
                const channelId = config.idCanalSaidas; 

                if (!channelId) return;

                const channel = member.guild.channels.cache.get(channelId);
                if (!channel) return;

                // Envia apenas o content
                await channel.send({
                    content: `Infelizmente o(a) **${member.user.username}** saiu do Rovix Applications! 💔`
                });

            } catch (error) {
                console.error("[EVENTO ERRO] Falha ao enviar log de saída:", error);
            }
        });
    }
};