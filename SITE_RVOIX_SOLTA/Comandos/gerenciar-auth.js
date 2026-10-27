const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    PermissionFlagsBits,
    SlashCommandBuilder,
} = require('discord.js');
const axios = require('axios');

const LOCAL_API = `http://127.0.0.1:${process.env.FORCE_PORT || process.env.PORT || 3000}`;
const SITE_URL = (process.env.PUBLIC_URL || process.env.PUBLIC_BASE_URL || process.env.BASE_URL || 'https://rovixapplications.camposcloud.app').replace(/\/+$/, '');

function headers() {
    return { Authorization: `Bearer ${process.env.API_KEY || ''}` };
}

async function fetchSiteAuthInfo(guildId = '') {
    const params = guildId ? { guild_id: guildId } : {};
    const response = await axios.get(`${LOCAL_API}/api/site-auth/info`, {
        headers: headers(),
        params,
        timeout: guildId ? 180000 : 60000,
    });
    return response.data;
}

function n(value) {
    return `\`${Number(value || 0)}\``;
}

function buildEmbed(info) {
    const embed = new EmbedBuilder()
        .setTitle('Gerenciar Auth do Site')
        .setColor(0xffffff)
        .setDescription([
            'Controle separado do login OAuth do site.',
            'Quem estiver sem permissao salva precisa entrar novamente pelo login do site.',
        ].join('\n'))
        .addFields(
            { name: 'Logins no site', value: n(info.total_discord), inline: true },
            { name: 'Com permissao OAuth', value: n(info.com_token), inline: true },
            { name: 'Precisam relogar', value: n(info.sem_token), inline: true },
        );

    if (info.guild_id) {
        embed.addFields(
            { name: 'Ja no servidor', value: n(info.ja_no_servidor), inline: true },
            { name: 'Fora e prontos', value: n(info.fora_com_token ?? info.prontos_para_puxar), inline: true },
            { name: 'Fora sem permissao', value: n(info.fora_sem_token), inline: true },
        );
    } else {
        embed.addFields(
            { name: 'Prontos para puxar', value: n(info.prontos_para_puxar ?? info.com_token), inline: true },
            { name: 'Status do servidor', value: '`use Verificar Servidor`', inline: true },
        );
    }

    if (info.aviso) {
        embed.addFields({ name: 'Aviso', value: info.aviso.slice(0, 1000), inline: false });
    }

    return embed;
}

function buildPullResultEmbed(detalhes) {
    const embed = new EmbedBuilder()
        .setTitle('Puxada de Membros Finalizada')
        .setColor(0xffffff)
        .setDescription('Resultado da tentativa de puxar somente contas com permissao OAuth salva.')
        .addFields(
            { name: 'Logins no site', value: n(detalhes.total_discord), inline: true },
            { name: 'Com permissao', value: n(detalhes.com_token), inline: true },
            { name: 'Sem permissao', value: n(detalhes.sem_token), inline: true },
            { name: 'Ja estavam no servidor', value: n(detalhes.ja_no_servidor), inline: true },
            { name: 'Adicionados agora', value: n(detalhes.adicionados), inline: true },
            { name: 'Falhas', value: n(detalhes.falhas), inline: true },
        );

    if (detalhes.fora_sem_token) {
        embed.addFields({
            name: 'Precisam relogar',
            value: `${n(detalhes.fora_sem_token)} conta(s) estao fora do servidor, mas nao autorizaram o site ainda.`,
            inline: false,
        });
    }

    const erros = detalhes.erros || {};
    const errosTexto = Object.entries(erros)
        .slice(0, 5)
        .map(([erro, total]) => `${total}x ${erro}`)
        .join('\n');
    if (errosTexto) embed.addFields({ name: 'Erros principais', value: errosTexto.slice(0, 1000), inline: false });

    return embed;
}

function buildRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('siteauth_refresh')
                .setLabel('Atualizar')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('siteauth_check')
                .setLabel('Verificar Servidor')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId('siteauth_pull')
                .setLabel('Puxar Membros')
                .setStyle(ButtonStyle.Success),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Link para Relogar')
                .setURL(`${SITE_URL}/api/auth/discord`)
                .setStyle(ButtonStyle.Link),
        ),
    ];
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('gerenciar-auth-site')
        .setDescription('Gerencie o Auth do site e puxe membros verificados.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(_client, interaction) {
        await interaction.deferReply({ ephemeral: true });
        const info = await fetchSiteAuthInfo();

        return interaction.editReply({
            embeds: [buildEmbed(info)],
            components: buildRows(),
        });
    },

    buildEmbed,
    buildPullResultEmbed,
    buildRows,
    fetchSiteAuthInfo,
};
