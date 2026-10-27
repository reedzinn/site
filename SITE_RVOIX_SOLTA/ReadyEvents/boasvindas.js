const fs = require('fs');
const path = require('path');

module.exports = {
    run: (client) => {
        console.log("[READY] Script de Boas-Vindas (Apenas Content) ativado!");

        client.on("guildMemberAdd", async (member) => {
            try {
                // Caminho para o seu novo arquivo de configuração
                const configPath = path.join(__dirname, "../database/configuracaoready.json");
                
                if (!fs.existsSync(configPath)) {
                    return console.warn("[READY ERRO] Arquivo configuracaoready.json não encontrado!");
                }

                // Lê o arquivo e busca o ID do canal
                const configRaw = fs.readFileSync(configPath, 'utf8');
                const config = JSON.parse(configRaw);
                const channelId = config.idCanalBoasVindas; // Certifique-se que o nome da chave no JSON seja este

                if (!channelId) return;

                const channel = member.guild.channels.cache.get(channelId);
                if (!channel) return;

                // Envia apenas o content conforme solicitado
                await channel.send({
                    content: `👋 Bem vindo (a) ${member} ao Rovix Applications!`
                });

            } catch (error) {
                console.error("[EVENTO ERRO] Falha ao enviar boas-vindas:", error);
            }
        });
    }
};