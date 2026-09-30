# 7 Mailboxes and channels

## 7.1 Mailboxes

An address's **mailbox** is the deliveries addressed to it, with their messages,
in every state. Its `held` deliveries are mail waiting for the recipient: for a
work item until its next session starts ([§6.4](06-delivery.md#s6.4)), for an
agent until it reads them, and for an ended session until a later session of its
work item claims them. A host lets a recipient list its mailbox, optionally
filtered by state, and open the threads its messages belong to.

**Marking read.** A recipient marks a delivery read by its id. A delivery in any
state but `answered` becomes `read`; marking a delivery that is already `read`
or `answered` changes nothing and succeeds. Marking a delivery that does not
exist fails `not-found`.

**Open questions.** A host lets a deciding principal list the open blocking
questions and handoffs: those with `blocking: true` and no answer yet. Answering
one closes it for everyone ([§4.7](04-messages.md#s4.7)).

## 7.2 Channels

A **channel** is a named group of recipients. Its name is one or more
identifiers joined by `/` ([§3.1](03-addresses.md#s3.1)). A channel exists from
its first join: joining a member to a channel that does not exist creates it,
and a channel no one has joined, with no implicit members
([§3.6](03-addresses.md#s3.6)), is unknown ([§3.5](03-addresses.md#s3.5)).

A message to a channel reaches every member at send time, through the route
`channel`, and members who join later do not receive earlier messages. A session
reached through a channel is notified rather than pushed unless the message is
urgent ([§6.2](06-delivery.md#s6.2)), and a session that is not live gets
nothing ([§6.1](06-delivery.md#s6.1)).

## 7.3 Membership

A channel's members are work items and actors: `task:`, `human:` and `agent:`
addresses. Membership outlives any one session, so a session joins as its work
item. A host MUST refuse, as `invalid` on `member`, a join whose member is a
session (`run:`) or a channel (`channel:`), and MUST skip a stored member that
is a channel when it resolves a send, so that no channel is ever a recipient
([§3.5](03-addresses.md#s3.5)). (pinned rule 14; vectors:
`core.channels.a-session-cannot-join`,
`core.channels.a-channel-cannot-join-a-channel`,
`core.channels.a-stored-channel-member-is-skipped`)

Joining an existing member again changes nothing. Leaving removes an explicit
member and reports whether one was removed; it never removes an implicit member,
which the host computes. Which principals may join or remove which members is
the host's policy; the Dispatch profile lets a principal join or leave as an
address it acts for ([Appendix A](appendix-a-daemon-api.md#sA)).
