// Address rules depend on the country (e.g. Kenya: no ZIP needed; US: state + ZIP needed)
const validateAddress = (address, country) => {
    if (!address || typeof address !== 'object') return 'Address is required';
    if (!String(address.street || '').trim()) return 'Street address is required';
    if (!String(address.city || '').trim()) return 'City is required';
    if (country.regionRequired && !String(address.state || '').trim()) return `${country.regionLabel} is required`;
    if (country.postalRequired && !String(address.zipCode || '').trim()) return `${country.postalLabel} is required`;
    if (address.country && String(address.country).toUpperCase() !== country.code) {
        return `This chef only serves ${country.name}`;
    }
    return null;
};


module.exports = { validateAddress };
