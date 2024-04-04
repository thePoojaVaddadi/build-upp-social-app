import { App, WorkflowStep } from '@slack/bolt';
import { NextApiRequest, NextApiResponse } from 'next';
import NextConnectReceiver from '../../utils/NextConnectReceiver';
import { kv } from '@vercel/kv';

const receiver = new NextConnectReceiver({
    signingSecret: process.env.SLACK_SIGNING_SECRET || 'invalid',
    processBeforeResponse: true,
});

const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    receiver: receiver,
    developerMode: false,
});

async function matchMembersInChannel(channel: string, client: any) {
    try {
        console.log('Triggering matching logic for Channel ID: ' + channel);

        const res = await client.conversations.members({ channel: channel });
        const members = res.members;

        const profiles = [];
        for (const memberId of members) {
            const profileRes: any = await client.users.profile.get({ user: memberId });
            if (!profileRes.profile.bot_id) {
                profiles.push({
                    id: memberId,
                    tzOffset: profileRes.profile.tz_offset,
                    name: profileRes.profile.real_name,
                });
            }
        }

        console.log(profiles.length + ' user profiles found.');

        profiles.sort((a, b) => a.tzOffset - b.tzOffset);

        let outputMessage = '';
        while (profiles.length > 1) {
            const member1 = profiles.shift();
            const member2 = profiles.pop();

            if (member1 && member2) {
                outputMessage += `* <@${member1.id}> matched with <@${member2.id}>. <@${member1.id}>, you are in charge of scheduling the 1-1.\n`;
            }
        }

        if (profiles.length === 1) {
            const member = profiles[0];
            outputMessage += `* <@${member.id}> couldn't be paired with anyone.\n`;
        }

        console.log('Sending matching message to Slack...');

        await client.chat.postMessage({
            token: process.env.SLACK_BOT_TOKEN,
            channel: channel,
            text: outputMessage,
        });
    } catch (error) {
        console.error(error);
    }
}

app.command('/buddy_up', async ({ command, ack, client }) => {
    await ack();

    console.log('Buddy Up Command invoked in Channel ID: ' + command.channel_id);

    await matchMembersInChannel(command.channel_id, client);
});

// Listen for the shortcut invocation event
app.shortcut('buddy_up', async ({ ack, body, client }) => {
    await ack();

    console.log('Buddy Up Shortcut invoked. Trigger ID: ' + body.trigger_id);

    try {
        // Call views.open with the built-in client
        const result = await client.views.open({
            trigger_id: body.trigger_id,
            view: {
                type: 'modal',
                callback_id: 'buddy_up_shortcut_channel_selected',
                title: {
                    type: 'plain_text',
                    text: 'Buddy Up'
                },
                blocks: [
                    {
                        type: 'input',
                        block_id: 'block_1',
                        element: {
                            type: 'conversations_select',
                            action_id: 'action_1',
                            placeholder: {
                                type: 'plain_text',
                                text: 'Select a channel'
                            },
                        },
                        label: {
                            type: 'plain_text',
                            text: 'Channel to look up members to match',
                        },
                    },
                ],
                submit: {
                    type: 'plain_text',
                    text: 'Submit',
                },
            },
        });
    }
    catch (error) {
        console.error(error);
    }
});

// Handle the view_submission event
app.view('buddy_up_shortcut_channel_selected', async ({ ack, body, view, client }) => {
    // Acknowledge the view_submission event
    await ack();

    console.log('Buddy Up Shortcut channel Selected');
    const selectedChannel = view.state.values.block_1.action_1.selected_conversation as string;
    
    await matchMembersInChannel(selectedChannel, client);

});

// Define the workflow step
const buddyUpWorkflowStep = new WorkflowStep('buddy_up', {
    edit: async ({ ack, step, configure }) => {
        await ack();

        const blocks = [
            {
                type: 'input',
                block_id: 'selected_channel_block',
                element: {
                    type: 'conversations_select',
                    action_id: 'selected_channel_action',
                    placeholder: {
                        type: 'plain_text',
                        text: 'Select a channel',
                        emoji: true
                    }
                },
                label: {
                    type: 'plain_text',
                    text: 'Channel',
                    emoji: true
                }
            }
        ];

        await configure({ blocks });
    },
    save: async ({ ack, step, update, view }) => {
        await ack();

        const selectedChannel = view.state.values.selected_channel_block.selected_channel_action.selected_conversation;

        console.log('Setting key: ' + step.workflow_id + ' with value: ' + selectedChannel);

        // Save the channel selected by the user to the Vercel KV
        await kv.set(step.workflow_id, selectedChannel);

        const inputs = { channel: { value: selectedChannel } };
        const outputs = [{ name: "message", type: "text", label: "Saved Workflow + Channel Link" }];
        await update({ inputs, outputs });
    },
    execute: async ({ step, complete, client }) => {
        // Retrieve the selected channel from Vercel KV
        const channel = await kv.get(step.workflow_id) as string;

        console.log('Getting key: ' + step.workflow_id + ' with value: ' + channel);

        // Calling the matchMembersInChannel function with selected channel and client
        await matchMembersInChannel(channel, client);

        const outputs = [{ name: "message", type: "text", label: "Matched Pairs" }];
        complete({ outputs });
    },
});

app.step(buddyUpWorkflowStep);

const router = receiver.start();

router.get('/api', (req: NextApiRequest, res: NextApiResponse) => {
    res.status(200).json({ test: true });
})

export default router;
