// Public links to a meal's photo. The version number changes whenever the photo is replaced,
// so browsers can cache each picture "forever" and still show the new one at once.
const photoUrls = (meal) => {
    if (!meal || !meal.photoVersion) return { photo: null, thumb: null };
    const base = `/api/photos/meals/${meal._id}?v=${meal.photoVersion}`;
    return { photo: base, thumb: `${base}&size=thumb` };
};
module.exports = { photoUrls };
