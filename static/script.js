document.addEventListener("DOMContentLoaded", function() {
    const audio = document.getElementById('audioPlayer');
    const playPauseButton = document.getElementById('playButton');
    const forwardButton = document.getElementById('forwardButton');
    const backwardButton = document.getElementById('backwardButton');
    playPauseButton.className = "play";
    forwardButton.disabled = true;
    backwardButton.disabled = true;

    function getMediaSource() {
	if (window.ManagedMediaSource) {
            return new window.ManagedMediaSource();
	}
	if (window.MediaSource) {
            return new window.MediaSource();
	}

	throw "No MediaSource API available";
    }
    const mediaSource = getMediaSource();
    
//    let mediaSource = new MediaSource();
    let sourceBuffer;
    let queue = [];
    let socket;
    let isInitialized = false;
    let lastTime = 0;
    let requested = false;
    let startOnce = true;
    let percentageDone = 0;
    let totalSize = 0;

    const MIN_BUFFER_THRESHOLD = 10;

    function arrayBufferToMd5(arrayBuffer) {
	// Convert ArrayBuffer to WordArray first
	var wordArray = CryptoJS.lib.WordArray.create(arrayBuffer);
    
	// Compute MD5 hash
	var hash = CryptoJS.MD5(wordArray);
    
	// Convert the hash to a hexadecimal string
	return hash.toString(CryptoJS.enc.Hex);
    }
    
    function getClientId() {
        let clientId = localStorage.getItem("clientId");
        if (!clientId) {
            clientId = Math.floor(Math.random() * 10000).toString();
            localStorage.setItem("clientId", clientId);
        }
        return clientId;
    }

    // Function to fetch the file size from the FastAPI endpoint
    function fetchFileSize() {
	fetch(`https://${location.host}/size`)
	    .then(response => {
		if (!response.ok) {
		    throw new Error('Network response was not ok');
		}
		return response.json();
	    })
	    .then(data => {
		if (data.error) {
		    console.error('Error fetching file size:', data.error);
		} else {
		    console.log("File size", data.file_size);
		    totalSize = data.file_size;
		    playPauseButton.textContent = calculatePercentage();
		    return data.file_size;
		}
	    })
	    .catch(error => {
		console.error('There was a problem with your fetch operation:', error);
	    });
    }    

    fetchFileSize();

    // Function to calculate the percentage
    function calculatePercentage() {
	const position = getCookie('last_position');
	if (position) {
	    console.log("Current position", position);
	    console.log("Max position", totalSize);
	    const percentage = (position / totalSize) * 100;
	    console.log(`Percentage: ${percentage.toFixed(2)}%`);
	    return percentage.toFixed(2);
	} else {
	    console.log("Cookie 'position' not found.");
	    return 0;
	}
    }
    
    function getCookie(name) {
	let cookieArray = document.cookie.split(';'); // Split document.cookie at each semicolon (which separates cookies)
	for (let cookie of cookieArray) {
            let [cookieName, cookieValue] = cookie.trim().split('='); // Split each individual cookie into name and value at the equal sign
            if (cookieName === name) {
		return cookieValue; // Return the value if the names match
            }
	}
	return null; // Return null if the cookie was not found
    }

    function updateCookie(name, value) {
	const daysToExpire = 7; // Number of days until the cookie should expire
	let expires = new Date(Date.now() + daysToExpire * 86400000).toUTCString(); // Calculate expiration date
	document.cookie = `${name}=${value}; expires=${expires}; path=/`; // Set the cookie with expiration and path
    }

    function checkBufferHealth() {
        if (mediaSource.readyState === 'open' && !sourceBuffer.updating) {
            let bufferEnd = sourceBuffer.buffered.length > 0 ? sourceBuffer.buffered.end(0) : 0;
            let timeLeft = bufferEnd - audio.currentTime;
	    console.log(`${bufferEnd} ${timeLeft}`);

            if (timeLeft < MIN_BUFFER_THRESHOLD && !requested) {
		console.log(document.cookie);
                socket.send("next");
		requested = true;
		let lastPosition = parseInt(getCookie('last_position'));
		lastPosition += 128*1024;
		updateCookie('last_position', lastPosition);
		playPauseButton.textContent = calculatePercentage();
		console.log(`Updated last_position to ${lastPosition}`);
            }
        }
    }

    async function clearBuffer() {
	return new Promise((resolve, reject) => {
            if (!sourceBuffer.updating && sourceBuffer.buffered.length > 0) {
		let start = sourceBuffer.buffered.start(0);
		let end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);

		function onUpdateEnd() {
                    console.log('Buffer has been cleared');
                    sourceBuffer.removeEventListener('updateend', onUpdateEnd);
                    resolve(); // Resolve the promise when buffer clearing is confirmed
		}
		sourceBuffer.addEventListener('updateend', onUpdateEnd);
		
		try {
                    sourceBuffer.remove(start, end);
		} catch (error) {
                    console.error('Failed to remove buffer:', error);
                    sourceBuffer.removeEventListener('updateend', onUpdateEnd);
                    reject(error); // Reject the promise if removal fails
		}
            } else {
		console.log('No buffer to clear or sourceBuffer is updating');
		resolve(); // Resolve immediately if there's nothing to clear
            }
	});
    }

    audio.onpause = () => {
	forwardButton.disabled = true;
	backwardButton.disabled = true;
        playPauseButton.className = "play";
    }
    
    audio.onplay = () => {
	forwardButton.disabled = false;
	backwardButton.disabled = false;
        playPauseButton.className = "pause";
	console.log("Audio play");
	if (startOnce) {
            setInterval(checkBufferHealth, 1000);  // Check buffer health every second while playing
	    startOnce = false;
	}
    };

    
    function connectWebSocket() {
	const clientId = getClientId();
        socket = new WebSocket(`wss://${location.host}/ws/${clientId}`);
        socket.binaryType = 'arraybuffer';  // Receive data as ArrayBuffer

        socket.onmessage = function(event) {
            console.log("Received chunk");
	    var md5Hash = arrayBufferToMd5(event.data);
	    console.log("MD5 Hash:", md5Hash);
	    requested = false;
            if (sourceBuffer && !sourceBuffer.updating && queue.length === 0) {
		console.log("Appending");
                sourceBuffer.appendBuffer(event.data);
            } else {
		console.log("Updating");
                queue.push(event.data);
            }
        };

        socket.onopen = function() {
            console.log("WebSocket connected.");
	    socket.send("next");
        };

        socket.onerror = function(event) {
            console.error("WebSocket error:", event);
        };

        socket.onclose = function(event) {
            console.log("WebSocket closed.");
        };
    }

    function sourceOpen() {
        sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
        sourceBuffer.addEventListener('updateend', function() {
	    console.log(`Buffered ranges: ${sourceBuffer.buffered.length}`);
	    for (let i = 0; i < sourceBuffer.buffered.length; i++) {
		console.log(`Start ${i}: ${sourceBuffer.buffered.start(i)}, End ${i}: ${sourceBuffer.buffered.end(i)}`);
	    }
            if (queue.length > 0 && !sourceBuffer.updating) {
                sourceBuffer.appendBuffer(queue.shift());
            }
	    if (audio.paused && sourceBuffer.buffered.length > 0) {
		audio.currentTime = sourceBuffer.buffered.start(0);
		audio.play();
		console.log(`Starting audio from ${audio.currentTime}`);
	    }
        });

        connectWebSocket();
    }

    mediaSource.addEventListener('sourceopen', sourceOpen);


    playPauseButton.addEventListener('click', function() {
	// sanity check on the cookie
	let lastPosition = parseInt(getCookie('last_position'));
	if (isNaN(lastPosition)) updateCookie('last_position', 0);
	if (lastPosition < 0) updateCookie('last_position', 0);
	
	if (audio.src == "") {
	    audio.src = URL.createObjectURL(mediaSource);
	} else if (audio.paused) {
	    socket.send("next");
        } else {
	    console.log("Audio pause");
            audio.pause();
        }
    });

    async function pauseAndSeek(position) {
	audio.pause();
	console.log("Audio paused");
	console.log("Seek to", position);
	if (position < 0) position = 0;
	socket.send(`seek=${position}`);
	updateCookie('last_position', position);
	await clearBuffer();
	console.log(`MediaSource readyState: ${mediaSource.readyState}`);
	playPauseButton.textContent = calculatePercentage();
        playPauseButton.className = "play";
    }
    
    forwardButton.addEventListener('click', function() {
	let lastPosition = parseInt(getCookie('last_position'));
	lastPosition += 128*1024;
	pauseAndSeek(lastPosition);
    });

    backwardButton.addEventListener('click', function() {
	let lastPosition = parseInt(getCookie('last_position'));
	lastPosition -= 2*128*1024;
	pauseAndSeek(lastPosition);
    });

    
});