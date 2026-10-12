const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: "demo",
  api_key: "895475376332155",
  api_secret: "wV5wL15T6vW_M_B_aD7t7gXh-4s"
});

cloudinary.uploader.upload("https://via.placeholder.com/150", function(error, result) {
  if (error) {
    console.log("Error:", error.message);
  } else {
    console.log("Success:", result.secure_url);
  }
});
