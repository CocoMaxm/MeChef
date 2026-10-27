const crypto = require('crypto');
const Order = require('../models/Order.model');
const Chef = require('../models/Chef.model');
const Meal = require('../models/Meal.model');
const K = require('../config/kitchen');
const { getCountry } = require('../config/countries');
const { validateAddress } = require('../utils/address.util');
const { normalizePhone, escapeHtml } = require('../utils/helpers.util');
const { formatMoney } = require('../utils/money.util');
const { covers } = require('../utils/kitchen.util');
const { PRIVATE_KITCHEN_FIELDS } = require('./kitchen.controller');
const sendEmail = require('../utils/email.util');

const ACCEPTED = ['accepted', 'preparing', 'ready', 'completed'];
const PICKUP_VISIBLE = ['accepted', 'preparing', 'ready'];
// what the chef can do next with an order
const CHEF_NEXT = { pending: ['accepted', 'rejected'], accepted: ['preparing', 'ready', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['completed'] };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: easy to read out to a rider

const fail = (res, status, error) => res.status(status).json({ success: false, error });
const newCode = async () => {
    for (let i = 0; i < 8; i++) {
        const code = 'CM-' + Array.from({ length: 5 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
        if (!(await Order.exists({ code }))) return code;
    }
    throw new Error('Could not create an order code');
};
const itemsHtml = (o) => `<ul>${o.items.map((i) => `<li>${i.quantity} × ${escapeHtml(i.name)}${i.note ? ` <em>(${escapeHtml(i.note)})</em>` : ''}</li>`).join('')}</ul>`;
const when = (date, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(date);

// What each side is allowed to see. The chef only gets the customer's phone and street AFTER accepting;
// the customer only gets the kitchen's phone and pickup address once the order is accepted AND they need it (pickup / own rider).
const view = (doc, role) => {
    const o = doc.toObject();
    const chef = o.chef && o.chef._id && o.chef.serviceLocation ? o.chef : null;
    const kitchen = (chef && chef.kitchen) || {};
    const accepted = ACCEPTED.includes(o.status);
    const out = { ...o, courier: o.courier || {} };

    if (chef) {
        out.chef = {
            _id: chef._id, kitchenName: kitchen.name || '', cuisine: chef.cuisineSpecialization, city: chef.serviceLocation.city,
            chefName: chef.user && chef.user.firstName ? `${chef.user.firstName} ${chef.user.lastName}` : ''
        };
    }
    out.pickup = null;
    if (role === 'customer' && chef && PICKUP_VISIBLE.includes(o.status) && (o.fulfilment === 'pickup' || (o.courier && o.courier.arrangedBy === 'customer'))) {
        const a = kitchen.pickupAddress || {};
        out.pickup = { kitchenName: kitchen.name, address: [a.street, a.city, a.state, a.zipCode].filter(Boolean).join(', '), phone: kitchen.phone };
    }
    if (role === 'chef') {
        out.customerName = o.customer && o.customer.firstName ? `${o.customer.firstName} ${o.customer.lastName}` : '';
        delete out.customer;
        if (!accepted && o.status !== 'cancelled') {
            out.customerPhone = null;
            if (o.dropoff) out.dropoff = { city: o.dropoff.city, area: o.dropoff.area, state: o.dropoff.state };
        }
    }
    return out;
};

// @route POST /api/orders  (private, customer with a confirmed email)
// body: { chefId, items: [{ mealId, quantity, note }], fulfilment: 'delivery'|'pickup', phone, dropoff: {...}, notes }
exports.createOrder = async (req, res, next) => {
    try {
        const { chefId, items, fulfilment, phone, dropoff, notes } = req.body;

        const chef = await Chef.findOne({ _id: chefId, isActive: true, isVerified: true, 'kitchen.enabled': true }).populate('user');
        if (!chef) return fail(res, 404, 'Kitchen not found');
        if (chef.kitchen.acceptingOrders === false) return fail(res, 409, 'This kitchen is not taking orders right now');
        const country = getCountry(chef.serviceLocation.country);

        if (!Array.isArray(items) || !items.length || items.length > 30) return fail(res, 400, 'Add 1 to 30 meals to your order');
        const wanted = new Map(); // mealId -> { quantity, note }
        for (const it of items) {
            const qty = Number(it && it.quantity);
            if (!it || typeof it.mealId !== 'string' || !Number.isInteger(qty) || qty < 1 || qty > 20) return fail(res, 400, 'Each meal needs a quantity from 1 to 20');
            const note = it.note ? String(it.note).trim().slice(0, 200) : '';
            const prev = wanted.get(it.mealId);
            const total = (prev ? prev.quantity : 0) + qty;
            if (total > 20) return fail(res, 400, 'You can order at most 20 of one meal');
            wanted.set(it.mealId, { quantity: total, note: note || (prev && prev.note) || '' });
        }
        const meals = await Meal.find({ _id: { $in: [...wanted.keys()] }, chef: chef._id, isAvailable: true });
        if (meals.length !== wanted.size) return fail(res, 400, 'One or more meals are no longer available. Please refresh the menu.');

        // Prices always come from the database, never from the browser
        const lines = meals.map((m) => ({ meal: m._id, name: m.name, price: m.price, quantity: wanted.get(String(m._id)).quantity, note: wanted.get(String(m._id)).note || undefined }));
        const subtotal = lines.reduce((sum, l) => sum + l.price * l.quantity, 0);
        if (subtotal < (chef.kitchen.minOrder || 0)) return fail(res, 400, `The minimum order for this kitchen is ${formatMoney(chef.kitchen.minOrder, country)}`);

        if (!['delivery', 'pickup'].includes(fulfilment)) return fail(res, 400, 'Choose delivery or pickup');
        const flags = chef.kitchen.fulfilment || {};
        if (fulfilment === 'delivery' && flags.courier === false) return fail(res, 400, 'This kitchen does not offer rider delivery');
        if (fulfilment === 'pickup' && flags.pickup === false) return fail(res, 400, 'This kitchen does not offer pickup');
        const customerPhone = normalizePhone(phone);
        if (!customerPhone) return fail(res, 400, 'Enter your phone number in international format, e.g. +254712345678');

        let drop;
        if (fulfilment === 'delivery') {
            const addressError = validateAddress({ ...(dropoff || {}), country: dropoff && dropoff.country }, country);
            if (addressError) return fail(res, 400, addressError);
            if (!covers(chef, dropoff.city, dropoff.area, { strict: true })) {
                const areas = chef.kitchen.deliveryAreas || [];
                return fail(res, 400, areas.length
                    ? `This kitchen does not deliver there. It delivers to: ${areas.join(', ')}.`
                    : `This kitchen only delivers within ${chef.serviceLocation.city}.`);
            }
            drop = {
                street: String(dropoff.street).trim(), area: String(dropoff.area || '').trim(), city: String(dropoff.city).trim(),
                state: String(dropoff.state || '').trim(), zipCode: String(dropoff.zipCode || '').trim(), country: country.code,
                instructions: dropoff.instructions ? String(dropoff.instructions).trim().slice(0, 200) : undefined
            };
        }

        const order = await Order.create({
            code: await newCode(), customer: req.user.id, chef: chef._id, country: country.code, currency: country.currency,
            items: lines, subtotal, fulfilment, customerPhone, dropoff: drop,
            notes: notes ? String(notes).trim().slice(0, 500) : undefined,
            courier: fulfilment === 'delivery' ? { arrangedBy: chef.kitchen.courierArrangedBy || 'chef' } : undefined
        });

        const total = formatMoney(subtotal, country);
        const how = fulfilment === 'delivery' ? `Delivery to ${escapeHtml(drop.area || drop.city)}` : 'Pickup';
        await Promise.all([
            sendEmail.safe({
                email: chef.user.email, subject: `New food order ${order.code}`,
                html: `<h2>New food order ${order.code}</h2>${itemsHtml(order)}<p><strong>Total:</strong> ${total} &middot; ${how}</p>
                       ${order.notes ? `<p><strong>Notes:</strong> ${escapeHtml(order.notes)}</p>` : ''}
                       <p>Open your dashboard to accept or decline it.</p>`
            }),
            sendEmail.safe({
                email: req.user.email, subject: `Order ${order.code} received`,
                html: `<h2>We sent your order to ${escapeHtml(chef.kitchen.name)}</h2>${itemsHtml(order)}<p><strong>Total:</strong> ${total}</p>
                       <p>You will get an email when the chef accepts it.</p>`
            })
        ]);

        res.status(201).json({ success: true, data: view(order, 'customer') });
    } catch (err) {
        next(err);
    }
};

// @route GET /api/orders  (private) - the customer's own orders, or the chef's incoming orders
exports.listOrders = async (req, res, next) => {
    try {
        let docs;
        if (req.user.role === 'customer') {
            docs = await Order.find({ customer: req.user.id })
                .populate({ path: 'chef', select: PRIVATE_KITCHEN_FIELDS, populate: { path: 'user', select: 'firstName lastName' } })
                .sort('-createdAt').limit(200);
        } else {
            const chef = await Chef.findOne({ user: req.user.id });
            if (!chef) return res.status(200).json({ success: true, count: 0, data: [] });
            docs = await Order.find({ chef: chef._id }).populate('customer', 'firstName lastName').sort('-createdAt').limit(200);
        }
        const data = docs.map((d) => view(d, req.user.role));
        res.status(200).json({ success: true, count: data.length, data });
    } catch (err) {
        next(err);
    }
};

const loadForUpdate = (id) => Order.findById(id)
    .populate('customer', 'firstName lastName email')
    .populate({ path: 'chef', select: PRIVATE_KITCHEN_FIELDS, populate: { path: 'user', select: 'firstName lastName email' } });

const isOwnerChef = (order, req) => order.chef && order.chef.user && String(order.chef.user._id) === req.user.id;
const isOwnerCustomer = (order, req) => order.customer && String(order.customer._id) === req.user.id;

// @route PUT /api/orders/:id/status   body: { status, readyInMinutes?, reasonCode?, reason? }
exports.updateOrderStatus = async (req, res, next) => {
    try {
        const { status, readyInMinutes, reasonCode, reason } = req.body;
        const order = await loadForUpdate(req.params.id);
        if (!order) return fail(res, 404, 'Order not found');
        const country = getCountry(order.country);
        const tz = country.timezone;

        if (req.user.role === 'customer') {
            if (!isOwnerCustomer(order, req)) return fail(res, 403, 'Not authorized to update this order');
            if (status !== 'cancelled') return fail(res, 403, 'Customers can only cancel an order');
            if (order.status !== 'pending') return fail(res, 400, 'You can only cancel an order the chef has not accepted yet');
            order.status = 'cancelled';
            order.statusReason = { code: 'customer_cancelled', note: reason ? String(reason).trim().slice(0, 300) : undefined, at: new Date() };
            await order.save();
            await sendEmail.safe({ email: order.chef.user.email, subject: `Order ${order.code} was cancelled`, html: `<p>The customer cancelled order ${order.code} before you accepted it.</p>` });
            return res.status(200).json({ success: true, data: view(order, 'customer') });
        }

        if (!isOwnerChef(order, req)) return fail(res, 403, 'Not authorized to update this order');
        if (!(CHEF_NEXT[order.status] || []).includes(status)) return fail(res, 400, `A ${order.status} order cannot be changed to ${status}`);

        let reasonInfo = null;
        if (status === 'rejected' || status === 'cancelled') {
            reasonInfo = K.ORDER_REASONS.find((r) => r.code === reasonCode);
            if (!reasonInfo) return fail(res, 400, 'Please choose a reason');
            order.statusReason = { code: reasonInfo.code, note: reason ? String(reason).trim().slice(0, 300) : undefined, at: new Date() };
        }
        if (status === 'accepted') {
            const mins = Number(readyInMinutes);
            if (!Number.isInteger(mins) || mins < 5 || mins > 240) return fail(res, 400, 'Tell the customer when it will be ready: 5 to 240 minutes');
            order.readyInMinutes = mins;
            order.readyAt = new Date(Date.now() + mins * 60000);
        }
        order.status = status;
        await order.save();

        const kitchen = order.chef.kitchen || {};
        const a = kitchen.pickupAddress || {};
        const pickupBlock = (order.fulfilment === 'pickup' || order.courier.arrangedBy === 'customer')
            ? `<p><strong>Collect from:</strong> ${escapeHtml([a.street, a.city, a.state].filter(Boolean).join(', '))}<br><strong>Kitchen phone:</strong> ${escapeHtml(kitchen.phone)}<br><strong>Order code:</strong> ${order.code}</p>` : '';
        const note = order.statusReason && order.statusReason.note ? `<p>Message from the chef: ${escapeHtml(order.statusReason.note)}</p>` : '';
        const to = order.customer.email;
        let subject, html;
        if (status === 'accepted') {
            subject = `Order ${order.code} accepted`;
            html = `<h2>${escapeHtml(kitchen.name)} accepted your order</h2><p>It will be ready in about ${order.readyInMinutes} minutes (around ${when(order.readyAt, tz)}).</p>${pickupBlock}
                    ${order.fulfilment === 'delivery' && order.courier.arrangedBy === 'chef' ? '<p>The chef will book a rider and share the rider details here.</p>' : ''}
                    ${order.fulfilment === 'delivery' && order.courier.arrangedBy === 'customer' ? '<p>Please book a rider (Bolt, Uber or any delivery app) to collect it, and add the rider details to your order.</p>' : ''}`;
        } else if (status === 'ready') {
            subject = `Order ${order.code} is ready`;
            html = `<h2>Your order is ready</h2>${order.fulfilment === 'pickup' ? pickupBlock : '<p>A rider will collect it for delivery.</p>'}`;
        } else if (status === 'completed') {
            subject = `Order ${order.code} completed`;
            html = '<h2>Enjoy your meal!</h2><p>Thank you for ordering with CuisineForMe.</p>';
        } else if (status === 'rejected' || status === 'cancelled') {
            subject = `Order ${order.code} ${status === 'rejected' ? 'declined' : 'cancelled'}`;
            html = `<h2>Your order was ${status === 'rejected' ? 'declined' : 'cancelled'} by ${escapeHtml(kitchen.name)}</h2><p>Reason: ${escapeHtml(reasonInfo.label)}</p>${note}<p>You can order from another kitchen on CuisineForMe.</p>`;
        }
        if (subject) await sendEmail.safe({ email: to, subject, html });

        res.status(200).json({ success: true, data: view(order, 'chef') });
    } catch (err) {
        next(err);
    }
};

// @route PUT /api/orders/:id/courier   body: { service, riderName?, riderPhone?, trackingLink? }
// Records which delivery app is bringing the food. Only the person who arranges the rider (chef or customer, set by the kitchen) can fill it in.
exports.setCourier = async (req, res, next) => {
    try {
        const order = await loadForUpdate(req.params.id);
        if (!order) return fail(res, 404, 'Order not found');
        const isChef = req.user.role === 'chef' && isOwnerChef(order, req);
        const isCustomer = req.user.role === 'customer' && isOwnerCustomer(order, req);
        if (!isChef && !isCustomer) return fail(res, 403, 'Not authorized to update this order');
        if (order.fulfilment !== 'delivery') return fail(res, 400, 'A pickup order does not use a delivery rider');
        const arranger = order.courier && order.courier.arrangedBy;
        if ((arranger === 'chef' && !isChef) || (arranger === 'customer' && !isCustomer)) {
            return fail(res, 403, `For this order the ${arranger} books the rider`);
        }
        if (!['accepted', 'preparing', 'ready'].includes(order.status)) return fail(res, 400, 'Rider details can be added after the order is accepted and until it is completed');

        const { service, riderName, riderPhone, trackingLink } = req.body;
        if (!K.codes(K.COURIER_SERVICES).includes(service)) return fail(res, 400, 'Choose the delivery service');
        const name = riderName ? String(riderName).trim() : '';
        if (name.length > 60) return fail(res, 400, 'The rider name is too long');
        let phone;
        if (riderPhone && String(riderPhone).trim()) {
            phone = normalizePhone(riderPhone);
            if (!phone) return fail(res, 400, 'Enter the rider phone in international format, e.g. +254712345678');
        }
        const link = trackingLink ? String(trackingLink).trim() : '';
        if (link && (link.length > 300 || !/^https:\/\/[^\s]+$/i.test(link))) return fail(res, 400, 'The tracking link must start with https://');

        order.courier.service = service;
        order.courier.riderName = name || undefined;
        order.courier.riderPhone = phone;
        order.courier.trackingLink = link || undefined;
        order.courier.updatedAt = new Date();
        await order.save();

        const label = K.COURIER_SERVICES.find((s) => s.code === service).label;
        const notify = isChef ? order.customer.email : order.chef.user.email;
        await sendEmail.safe({
            email: notify, subject: `Rider details for order ${order.code}`,
            html: `<h2>A rider is booked for order ${order.code}</h2><p><strong>Service:</strong> ${escapeHtml(label)}</p>
                   ${name ? `<p><strong>Rider:</strong> ${escapeHtml(name)}${phone ? ` (${escapeHtml(phone)})` : ''}</p>` : ''}
                   ${link ? `<p><a href="${escapeHtml(link)}">Track the delivery</a></p>` : ''}`
        });

        res.status(200).json({ success: true, data: view(order, isChef ? 'chef' : 'customer') });
    } catch (err) {
        next(err);
    }
};
