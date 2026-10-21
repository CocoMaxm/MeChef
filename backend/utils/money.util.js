const { getCountry } = require('../config/countries');

// formatMoney(5000, getCountry('KE')) -> "Ksh 5,000"   (uses the country's currency + locale)
const formatMoney = (amount, country) => {
    const c = country || getCountry();
    try {
        return new Intl.NumberFormat(c.locale, {
            style: 'currency', currency: c.currency,
            minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals
        }).format(amount);
    } catch (e) {
        return `${c.currency} ${amount}`;
    }
};

module.exports = { formatMoney };
